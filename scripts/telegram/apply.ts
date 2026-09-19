#!/usr/bin/env tsx
/**
 * npm run telegram:apply -- [--yes]
 *
 * Builds the same plan as telegram:plan, shows it, and — after an explicit
 * confirmation — executes only the actions in it. The identity mapping is
 * written after each successful Telegram operation, so a failure never
 * records something that was not created.
 *
 * Running it again with an unchanged configuration converges: every action
 * comes out NOOP and no request that could change anything is sent.
 */
import { runReconcileScript } from "./reconcile.js";

runReconcileScript("apply");
