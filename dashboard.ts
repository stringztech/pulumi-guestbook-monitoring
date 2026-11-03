// Grafana dashboard discovered by the sidecar via grafana_dashboard=1.
const panel = (id: number, title: string, expr: string, x: number, y: number, unit?: string) => ({
    id, title, type: "timeseries", datasource: { type: "prometheus", uid: "prometheus" },
    targets: [{ refId: "A", expr, legendFormat: "{{job}} {{pod}} {{guestbook_role}}" }],
    fieldConfig: { defaults: { unit: unit || "short" }, overrides: [] },
    gridPos: { h: 8, w: 12, x, y },
});
export const dashboard = {
    uid: "pulumi-guestbook", title: "Guestbook • Application Monitoring",
    tags: ["guestbook", "pulumi"], timezone: "browser", schemaVersion: 39,
    version: 1, refresh: "30s", time: { from: "now-1h", to: "now" },
    panels: [
        panel(1, "Frontend availability (1 = success)", 'probe_success{job="guestbook-frontend-http"}', 0, 0),
        panel(2, "Frontend HTTP probe duration (seconds)", 'probe_duration_seconds{job="guestbook-frontend-http"}', 12, 0, "s"),
        panel(3, "Redis connections", 'redis_connected_clients{namespace="monitoring"}', 0, 8),
        panel(4, "Redis commands per second", 'rate(redis_commands_processed_total{namespace="monitoring"}[5m])', 12, 8, "ops"),
        panel(5, "Guestbook pod CPU cores", 'sum by (pod) (rate(container_cpu_usage_seconds_total{namespace="guestbook",container!="",container!="POD"}[5m]))', 0, 16),
        panel(6, "Guestbook pod memory bytes", 'sum by (pod) (container_memory_working_set_bytes{namespace="guestbook",container!="",container!="POD"})', 12, 16, "bytes"),
    ],
};
