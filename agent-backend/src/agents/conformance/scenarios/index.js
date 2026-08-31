/**
 * Conformance scenario suite (STH-5).
 *
 * The full list of provider-neutral scenarios, in run order. The SAME array
 * is run against every driver (createClaudeBridge / createPiBridge) by the
 * harness — a scenario passing under one runtime and failing under another is
 * exactly the signal the migration work needs.
 */
import {
  streamingText,
  toolGrants,
  composeDenials,
  storageContainment,
  directVsProposed,
  citationsReferences,
  commentsLifecycle,
  projectConfig,
  orgKnowledge,
  activeDocument,
  subagentDispatch,
  dispatchDepthLimit,
  sharedBudget,
} from './app-behavior.js';
import {
  askUserFlow,
  detachReconnect,
  cancelDisconnect,
  retryTransient,
  nonTransientError,
  followUpContinuation,
  jobConversationState,
} from './lifecycle.js';
import { roleSmoke } from './roles.js';

export const SCENARIOS = [
  // Application behavior
  streamingText,
  toolGrants,
  composeDenials,
  storageContainment,
  directVsProposed,
  citationsReferences,
  commentsLifecycle,
  projectConfig,
  orgKnowledge,
  activeDocument,
  subagentDispatch,
  dispatchDepthLimit,
  sharedBudget,
  // Interaction and lifecycle
  askUserFlow,
  detachReconnect,
  cancelDisconnect,
  retryTransient,
  nonTransientError,
  followUpContinuation,
  jobConversationState,
  // Role smoke (STH-47 preview slice)
  roleSmoke,
];
