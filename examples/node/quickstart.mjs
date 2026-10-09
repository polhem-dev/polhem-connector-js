// @ts-check
/**
 * The walk-through of `../demo.mjs`, from Node.
 *
 *   npm run build
 *   node examples/node/quickstart.mjs
 *
 * The defaults match the framework's QuickStart.Server; examples/README.md says how to start it. Point
 * the example at another host with `POLHEM_ENDPOINT`, `POLHEM_API_KEY`, `POLHEM_USER`, `POLHEM_PASSWORD`
 * and `POLHEM_COMPANY`.
 */
import { runDemo } from '../demo.mjs';

const env = process.env;

try {
  await runDemo(
    {
      endpoint: env.POLHEM_ENDPOINT ?? 'http://localhost:5050/api',
      apiKey: env.POLHEM_API_KEY ?? 'quickstart-demo',
      user: env.POLHEM_USER ?? 'demo',
      password: env.POLHEM_PASSWORD ?? 'demo',
      companyId: env.POLHEM_COMPANY ?? 'DEMO',
    },
    (line) => console.log(line),
  );
} catch (error) {
  console.error(`Failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
