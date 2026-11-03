/**
 * Kubernetes Guestbook with Prometheus and Grafana.
 * Based on https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple
 *
 * The upstream PHP frontend does not expose /metrics. A blackbox probe checks
 * HTTP availability/latency instead of claiming request counters exist.
 */
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { dashboard } from "./dashboard";

const config = new pulumi.Config();
const isMinikube = config.getBoolean("isMinikube") ?? false;
const grafanaServiceType = config.get("grafanaServiceType") ?? (isMinikube ? "NodePort" : "LoadBalancer");
if (!["LoadBalancer", "NodePort"].includes(grafanaServiceType)) {
    throw new Error("grafanaServiceType must be LoadBalancer or NodePort");
}
const grafanaAdminUser = config.get("grafanaAdminUser") ?? "admin";
const grafanaAdminPassword = config.requireSecret("grafanaAdminPassword");
const grafanaNodePort = config.getNumber("grafanaNodePort") ?? 30300;
if (grafanaServiceType === "NodePort" && (grafanaNodePort < 30000 || grafanaNodePort > 32767)) {
    throw new Error("grafanaNodePort must be 30000–32767 (default Kubernetes NodePort range)");
}
const grafanaNodeHost = config.get("grafanaNodeHost");

const guestbookNs = new k8s.core.v1.Namespace("guestbook-namespace", {
    metadata: { name: "guestbook" },
});
const monitoringNs = new k8s.core.v1.Namespace("monitoring-namespace", {
    metadata: { name: "monitoring" },
});
const gbNamespace = guestbookNs.metadata.name;
const monNamespace = monitoringNs.metadata.name;

const redisLeaderLabels = { app: "redis-leader" };
const redisLeader = new k8s.apps.v1.Deployment("redis-leader", {
    metadata: { namespace: gbNamespace, labels: redisLeaderLabels },
    spec: {
        replicas: 1,
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: { containers: [{
                name: "redis-leader", image: "redis:7.4-alpine",
                ports: [{ containerPort: 6379, name: "redis" }],
                resources: { requests: { cpu: "100m", memory: "100Mi" }, limits: { memory: "256Mi" } },
                readinessProbe: { tcpSocket: { port: 6379 }, initialDelaySeconds: 5, periodSeconds: 5 },
            }] },
        },
    },
});
new k8s.core.v1.Service("redis-leader-service", {
    metadata: { namespace: gbNamespace, name: "redis-leader", labels: redisLeaderLabels },
    spec: { selector: redisLeaderLabels, ports: [{ name: "redis", port: 6379, targetPort: "redis" }] },
}, { dependsOn: [redisLeader] });

const redisReplicaLabels = { app: "redis-replica" };
const redisReplica = new k8s.apps.v1.Deployment("redis-replica", {
    metadata: { namespace: gbNamespace, labels: redisReplicaLabels },
    spec: {
        replicas: 2,
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: { containers: [{
                name: "redis-replica", image: "pulumi/guestbook-redis-replica",
                env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                ports: [{ containerPort: 6379, name: "redis" }],
                resources: { requests: { cpu: "100m", memory: "100Mi" }, limits: { memory: "256Mi" } },
                readinessProbe: { tcpSocket: { port: 6379 }, initialDelaySeconds: 5, periodSeconds: 5 },
            }] },
        },
    },
});
new k8s.core.v1.Service("redis-replica-service", {
    metadata: { namespace: gbNamespace, name: "redis-replica", labels: redisReplicaLabels },
    spec: { selector: redisReplicaLabels, ports: [{ name: "redis", port: 6379, targetPort: "redis" }] },
}, { dependsOn: [redisReplica] });

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    metadata: { namespace: gbNamespace, labels: frontendLabels },
    spec: {
        replicas: 3,
        selector: { matchLabels: frontendLabels },
        template: {
            metadata: { labels: frontendLabels },
            spec: { containers: [{
                name: "frontend", image: "pulumi/guestbook-php-redis",
                env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                ports: [{ containerPort: 80, name: "http" }],
                resources: { requests: { cpu: "100m", memory: "100Mi" }, limits: { memory: "256Mi" } },
                readinessProbe: { httpGet: { path: "/", port: "http" }, initialDelaySeconds: 5, periodSeconds: 10 },
            }] },
        },
    },
});
const frontendService = new k8s.core.v1.Service("frontend-service", {
    metadata: { namespace: gbNamespace, name: "frontend", labels: frontendLabels },
    spec: {
        type: isMinikube ? "ClusterIP" : "LoadBalancer",
        selector: frontendLabels,
        ports: [{ name: "http", port: 80, targetPort: "http" }],
    },
}, { dependsOn: [frontendDeployment] });

// Prometheus Operator, Prometheus, Grafana, kube-state-metrics, node-exporter.
const monitoring = new k8s.helm.v3.Release("monitoring", {
    name: "monitoring",
    namespace: monNamespace,
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    chart: "kube-prometheus-stack",
    version: config.get("monitoringChartVersion") || undefined,
    timeout: 900,
    values: {
        prometheus: { prometheusSpec: {
            serviceMonitorSelector: { matchLabels: { release: "monitoring" } },
            serviceMonitorNamespaceSelector: {},
            probeSelector: { matchLabels: { release: "monitoring" } },
            probeNamespaceSelector: {},
            retention: "2d",
            resources: { requests: { cpu: "200m", memory: "512Mi" } },
        } },
        grafana: {
            fullnameOverride: "guestbook-grafana",
            adminUser: grafanaAdminUser,
            adminPassword: grafanaAdminPassword,
            service: {
                type: grafanaServiceType,
                ...(grafanaServiceType === "NodePort" ? { nodePort: grafanaNodePort } : {}),
            },
            sidecar: { dashboards: { enabled: true, label: "grafana_dashboard", searchNamespace: "ALL" } },
        },
    },
}, { dependsOn: [monitoringNs] });

const blackbox = new k8s.helm.v3.Release("blackbox", {
    name: "blackbox",
    namespace: monNamespace,
    repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
    chart: "prometheus-blackbox-exporter",
    version: config.get("blackboxChartVersion") || undefined,
    values: { fullnameOverride: "guestbook-blackbox" },
}, { dependsOn: [monitoringNs] });

new k8s.apiextensions.CustomResource("guestbook-http-probe", {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "Probe",
    metadata: { name: "guestbook-frontend", namespace: monNamespace, labels: { release: "monitoring" } },
    spec: {
        jobName: "guestbook-frontend-http",
        interval: "30s",
        module: "http_2xx",
        prober: { url: "guestbook-blackbox.monitoring.svc.cluster.local:9115", path: "/probe", scheme: "http" },
        targets: { staticConfig: { static: ["http://frontend.guestbook.svc.cluster.local/"] } },
    },
}, { dependsOn: [monitoring, blackbox, frontendService] });

function redisExporter(role: "leader" | "replica") {
    const name = `guestbook-redis-${role}-exporter`;
    const labels = { app: name };
    const deployment = new k8s.apps.v1.Deployment(`${name}-deployment`, {
        metadata: { namespace: monNamespace },
        spec: {
            replicas: 1,
            selector: { matchLabels: labels },
            template: { metadata: { labels }, spec: { containers: [{
                name: "redis-exporter", image: "oliver006/redis_exporter:v1.67.0",
                env: [{ name: "REDIS_ADDR", value: `redis://${role === "leader" ? "redis-leader" : "redis-replica"}.guestbook.svc.cluster.local:6379` }],
                ports: [{ name: "metrics", containerPort: 9121 }],
                resources: { requests: { cpu: "20m", memory: "32Mi" } },
            }] } },
        },
    }, { dependsOn: [role === "leader" ? redisLeader : redisReplica] });
    new k8s.core.v1.Service(`${name}-service`, {
        metadata: { name, namespace: monNamespace, labels: { ...labels, guestbook_role: role } },
        spec: { selector: labels, ports: [{ name: "metrics", port: 9121, targetPort: "metrics" }] },
    }, { dependsOn: [deployment] });
    new k8s.apiextensions.CustomResource(`${name}-monitor`, {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "ServiceMonitor",
        metadata: { name, namespace: monNamespace, labels: { release: "monitoring" } },
        spec: {
            namespaceSelector: { matchNames: ["monitoring"] },
            selector: { matchLabels: { app: name } },
            endpoints: [{ port: "metrics", path: "/metrics", interval: "30s" }],
        },
    }, { dependsOn: [monitoring] });
}
redisExporter("leader");
redisExporter("replica");

new k8s.core.v1.ConfigMap("guestbook-dashboard", {
    metadata: {
        name: "guestbook-dashboard", namespace: monNamespace,
        labels: { grafana_dashboard: "1" },
    },
    data: { "guestbook.json": JSON.stringify(dashboard) },
}, { dependsOn: [monitoring] });

const grafanaService = k8s.core.v1.Service.get(
    "grafana-service-read", pulumi.interpolate`${monNamespace}/guestbook-grafana`,
    { dependsOn: [monitoring] },
);
export const grafanaUsername = grafanaAdminUser;
export const grafanaPassword = pulumi.secret(grafanaAdminPassword);
export const grafanaServiceName = "guestbook-grafana";
export const grafanaNamespace = "monitoring";
export const grafanaAccessInstructions = grafanaServiceType === "NodePort"
    ? `NodePort ${grafanaNodePort}. If no accessible node IP, run: kubectl -n monitoring port-forward svc/guestbook-grafana 3000:80`
    : "Use grafanaUrl once an external ingress is assigned, or port-forward: kubectl -n monitoring port-forward svc/guestbook-grafana 3000:80";
export const grafanaUrl = grafanaServiceType === "NodePort"
    ? (grafanaNodeHost ? `http://${grafanaNodeHost}:${grafanaNodePort}` : "http://localhost:3000 (requires kubectl port-forward)")
    : grafanaService.status.apply(status => {
        const ingress = status?.loadBalancer?.ingress?.[0];
        const host = ingress?.hostname || ingress?.ip;
        return host ? `http://${host}` : "http://localhost:3000 (requires kubectl port-forward)";
    });
export const guestbookUrl = isMinikube
    ? "http://localhost:8080 (requires kubectl -n guestbook port-forward svc/frontend 8080:80)"
    : frontendService.status.apply(s => {
        const ingress = s?.loadBalancer?.ingress?.[0];
        const host = ingress?.hostname || ingress?.ip;
        return host ? `http://${host}` : "http://localhost:8080 (requires kubectl -n guestbook port-forward svc/frontend 8080:80)";
    });
export const prometheusPortForward = "kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090";
