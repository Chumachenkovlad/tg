#!/usr/bin/env tsx
/**
 * npm run telegram:plan
 *
 * Read-only. Connects to Telegram, reads the recorded identity mapping,
 * verifies every id in it against Telegram, compares the result with the
 * desired state and prints the plan. Performs no mutation.
 */
import { runReconcileScript } from "./reconcile.js";

runReconcileScript("plan");
