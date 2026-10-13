// Steps of the rollover workflow (B8). Results are plain JSON. Implementations are imported
// lazily so the workflow bundle stays free of Node-only modules.

export async function sweepAlarmStep() {
  "use step";
  const { sweepAlarm } = await import("@/services/sweep");
  return sweepAlarm(new Date());
}

export async function sweepUsersStep(limit: number) {
  "use step";
  const { sweepDueUsers } = await import("@/services/sweep");
  return sweepDueUsers(new Date(), limit);
}

export async function sweepMaintenanceStep() {
  "use step";
  const { sweepMaintenance } = await import("@/services/sweep");
  return sweepMaintenance(new Date());
}
