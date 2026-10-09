// @ts-check
/**
 * The walk-through both examples run: sign in, read a form, then create, change and delete a record.
 *
 * It targets the framework's QuickStart.Server, whose `Staff` form has a master table (`Staff`) and
 * a detail table of phone numbers (`StaffPhone`). The record it creates is deleted at the end, so
 * the demo can run any number of times.
 */
import { PolhemClient, addRow, setCell } from '@polhem/connector';

/**
 * @typedef {object} DemoOptions
 * @property {string} endpoint The JSON-RPC endpoint, e.g. `http://localhost:5050/api`.
 * @property {string} apiKey Sent as `X-Api-Key` on every call.
 * @property {string} user
 * @property {string} password
 * @property {string} companyId The company whose data the form calls read and write.
 */

/**
 * Runs the walk-through, reporting each step through `log`.
 *
 * @param {DemoOptions} options
 * @param {(line: string) => void} log
 */
export async function runDemo(options, log) {
  const client = new PolhemClient({ endpoint: options.endpoint, apiKey: options.apiKey });

  // Anonymous: no sign-in needed.
  const ping = await client.system.ping();
  log(`Server is ${ping.status}.`);

  // Signs in and installs the session key; every call after this is encrypted without being asked.
  const login = await client.system.login(options.user, options.password);
  const expires = login.expiredAt ? client.formatDateTime(new Date(login.expiredAt)) : 'never';
  log(`Signed in as ${login.userName ?? options.user} (${client.timeZone}); the session expires ${expires}.`);

  // Form data belongs to a company, so enter one before calling a form.
  const { company } = await client.system.enterCompany(options.companyId);
  log(`Entered ${company?.companyName ?? options.companyId}.`);

  try {
    await walkThroughStaff(client, log);
  } finally {
    await client.system.logout();
    log('Signed out.');
  }
}

/**
 * @param {PolhemClient} client
 * @param {(line: string) => void} log
 */
async function walkThroughStaff(client, log) {
  const staff = client.form('Staff');

  // List: each cell already holds its column's type, here a boolean and a 'YYYY-MM-DD' day.
  const { table } = await staff.getList({ selectFields: 'sys_id,sys_name,hire_date,is_active' });
  log(`Staff has ${table?.rows.length ?? 0} rows:`);
  for (const row of table?.rows ?? []) {
    const { sys_id, sys_name, hire_date, is_active } = row.current ?? {};
    log(`  ${sys_id}  ${sys_name}  hired ${hire_date}${is_active ? '' : '  (inactive)'}`);
  }

  // Create: the server hands out a new record with its defaults; fill it in and save it.
  const blank = requireMasterDetail((await staff.getNewData()).dataSet);
  let { master, detail: phones } = blank;
  master = setCell(master, firstRow(master), 'sys_id', `JS${Date.now().toString(36).slice(-6).toUpperCase()}`);
  master = setCell(master, firstRow(master), 'sys_name', 'Ada Lovelace');
  phones = addRow(
    phones,
    { phone_type: 'Mobile', phone_no: '0912-345-678' },
    { master: firstRow(master), timeZone: client.timeZone },
  );
  const rowId = String(firstRow(master).current?.['sys_rowid']);
  const created = await staff.save({ dataSet: { ...blank.dataSet, tables: [master, phones] } });
  log(`Created ${firstRow(master).current?.['sys_id']}: ${JSON.stringify(created.affectedRows)}.`);

  try {
    // Change: read the record back, edit a cell and add another phone, then save the changes.
    const read = requireMasterDetail((await staff.getData({ rowId })).dataSet);
    let { master: readMaster, detail: readPhones } = read;
    readMaster = setCell(readMaster, firstRow(readMaster), 'sys_name', 'Augusta Ada King');
    readPhones = addRow(
      readPhones,
      { phone_type: 'Office', phone_no: '02-2345-6789' },
      { master: firstRow(readMaster), timeZone: client.timeZone },
    );
    const changed = await staff.save({ dataSet: { ...read.dataSet, tables: [readMaster, readPhones] } });
    log(`Changed the name and added a phone: ${JSON.stringify(changed.affectedRows)}.`);
  } finally {
    // Delete the record again, so the demo database stays as it was.
    const deleted = await staff.delete({ rowId });
    log(`Deleted it again: ${deleted.rowsAffected} row.`);
  }
}

/**
 * A data set the server returned, with its master table and its first detail table.
 *
 * @param {import('@polhem/connector').DataSet | undefined} dataSet
 */
function requireMasterDetail(dataSet) {
  const [master, detail] = dataSet?.tables ?? [];
  if (!dataSet || !master || !detail) throw new Error('Expected a data set with a master and a detail table.');
  return { dataSet, master, detail };
}

/**
 * The first row of a table. Each change returns a new table with new row objects, so the row is
 * always taken from the table the last change returned.
 *
 * @param {import('@polhem/connector').DataTable} table
 */
function firstRow(table) {
  const row = table.rows[0];
  if (!row) throw new Error(`Table '${table.tableName}' has no rows.`);
  return row;
}
