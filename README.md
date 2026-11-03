# Kubernetes Guestbook Monitoring

Pulumi TypeScript implementation of the [official Kubernetes Guestbook example](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple), extended with **Prometheus, Grafana, Blackbox Exporter, Redis Exporters and a six-panel Grafana dashboard**.

## Architecture

- **guestbook namespace:** PHP frontend (3 pods), Redis leader (1 pod), Redis replicas (2 pods).
- **monitoring namespace:** kube-prometheus-stack (Prometheus Operator, Prometheus, Grafana, node exporter, kube-state-metrics), Blackbox Exporter, Redis exporters.
- Prometheus **Probe** measures frontend availability and HTTP latency.
- Prometheus **ServiceMonitor** collects Redis backend metrics.
- Cluster/container metrics show Guestbook pod CPU and memory.
- The Grafana dashboard is provisioned from a Kubernetes ConfigMap using the Grafana sidecar.

> The original PHP Guestbook image has no native Prometheus `/metrics` endpoint. Blackbox HTTP probes measure availability and latency, **not** request counts or real-user HTTP error rates. To obtain request rates/error rates, add application instrumentation or a metrics-enabled proxy/ingress.

## Prerequisites

- Node.js 20+, npm, Pulumi CLI and kubectl.
- A Kubernetes cluster and correctly configured `KUBECONFIG`.
- Permissions to install Helm charts, CRDs and cluster-scoped resources.
- Enough cluster capacity for the monitoring stack.
- Network access to Helm chart repositories and the image registries.

## Deploy

```bash
npm install
npm run check
pulumi stack init dev
pulumi config set isMinikube true
pulumi config set grafanaServiceType NodePort
pulumi config set grafanaNodePort 30300
pulumi config set --secret grafanaAdminPassword
pulumi up
```

The password command prompts for a password. Never commit secrets. For a cloud cluster, instead set `isMinikube false` and `grafanaServiceType LoadBalancer`. The `grafanaNodeHost` config key optionally sets a reachable node hostname/IP for the NodePort output.

Optional chart versions (recommended for reproducible environments):

```bash
pulumi config set monitoringChartVersion <compatible-tested-version>
pulumi config set blackboxChartVersion <compatible-tested-version>
```

## Grafana access URL and default admin credentials

Pulumi outputs access details after successful deployment:

```bash
pulumi stack output grafanaUrl
pulumi stack output grafanaUsername
pulumi stack output --show-secrets grafanaPassword
pulumi stack output guestbookUrl
```

- **Username:** `admin` by default, override with `grafanaAdminUser`.
- **Password:** the secret provided in `grafanaAdminPassword` (retrievable as a secret stack output).
- **URL:** the external LoadBalancer address when provisioned, or NodePort at the configured node host; for local use, `http://localhost:3000` after port forwarding.

```bash
kubectl -n monitoring port-forward svc/guestbook-grafana 3000:80
kubectl -n guestbook port-forward svc/frontend 8080:80
```

Grafana: http://localhost:3000. Guestbook: http://localhost:8080.

## Verify Prometheus scraping

```bash
kubectl get pods -n guestbook
kubectl get pods -n monitoring
kubectl -n monitoring get servicemonitors,probes
kubectl -n monitoring port-forward svc/monitoring-kube-prometheus-prometheus 9090:9090
```

Open http://localhost:9090/targets. Look for the frontend probe and both Redis exporter targets, with status **UP**. In the Prometheus expression browser try:

```promql
probe_success{job="guestbook-frontend-http"}
probe_duration_seconds{job="guestbook-frontend-http"}
redis_up{namespace="monitoring"}
redis_connected_clients{namespace="monitoring"}
sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook",container!="",container!="POD"}[5m]))
sum by (pod) (container_memory_working_set_bytes{namespace="guestbook",container!="",container!="POD"})
```

Then open Grafana → Dashboards → **Guestbook • Application Monitoring**. Wait at least 30–60 seconds for first scrapes.

If there is no data, inspect target discovery and exporter logs, check that `release: monitoring` labels match the Prometheus selector, and check the provisioned Grafana Prometheus datasource UID. Redis replica metrics monitor the replica **Service**, not each replica independently.

## Cleanup

```bash
pulumi destroy
pulumi stack rm
```

## Security and scope

This is a demonstration deployment, not a production-hardened monitoring stack. Use HTTPS, access restrictions, secret management, persistent storage, alerting and pinned/tested chart versions in production. LoadBalancer exposure can incur cloud charges.

## Validation status

The source and dashboard have been prepared and inspected. A full `npm install && npm run check` and live `pulumi up` / scrape verification **have not been completed in a running Kubernetes cluster**. Deployment commands above document how to perform those checks.

## Attribution

Built as an extension of Pulumi's published [TypeScript Guestbook example](https://github.com/pulumi/examples/tree/master/kubernetes-ts-guestbook/simple).
