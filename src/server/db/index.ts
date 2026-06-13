import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

/**
 * A Drizzle client bound to the Worker's D1 database. Cheap to construct, so callers make one
 * per request (`db(this.env)` / `db(env)`) rather than sharing a module-level singleton.
 */
export const db = (env: Env) => drizzle(env.DB, { schema });

export { schema };
