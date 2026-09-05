import path from 'node:path';

/** Where the `setup` project stores the demo session for the authenticated groups (under a11y/report/, gitignored); absolute, because the setup writes it relative to the working directory while `test.use` resolves relative to the config. */
export const STORAGE_STATE = path.join(__dirname, 'report', 'demo-session.json');
