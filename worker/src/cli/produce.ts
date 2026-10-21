// `npm run produce`: one production run from the topic queue, same as WF2 (for debugging).
import { pool } from '../db.js';
import { produceOne } from '../produce.js';

const id = await produceOne();
console.log(id ? `Job #${id} done; see Telegram.` : 'Nothing to produce.');
await pool.end();
