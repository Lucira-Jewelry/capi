/** What an operator does in the console: check the file, then import exactly that file. */
export async function importCsv(
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: unknown }>,
  tenantId: string,
  csv: string,
) {
  const dry = (await call('POST', `/tenants/${tenantId}/import`, { csv, dryRun: true })).body as { checkToken?: string };
  return call('POST', `/tenants/${tenantId}/import`, { csv, checkToken: dry.checkToken });
}
