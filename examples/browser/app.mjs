// @ts-check
/** Runs the walk-through of `../demo.mjs` with the settings on the page. */
import { runDemo } from '../demo.mjs';

const form = /** @type {HTMLFormElement} */ (document.getElementById('settings'));
const output = /** @type {HTMLPreElement} */ (document.getElementById('log'));
const button = /** @type {HTMLButtonElement} */ (form.querySelector('button'));

/** @param {string} text @param {string} [className] */
function log(text, className) {
  const line = document.createElement('div');
  line.textContent = text;
  if (className) line.className = className;
  output.append(line);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const field = (/** @type {string} */ name) => String(new FormData(form).get(name) ?? '');
  output.replaceChildren();
  button.disabled = true;
  try {
    await runDemo(
      {
        endpoint: field('endpoint'),
        apiKey: field('apiKey'),
        user: field('user'),
        password: field('password'),
        companyId: field('companyId'),
      },
      (line) => log(line),
    );
  } catch (error) {
    log(`Failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    button.disabled = false;
  }
});
