/** Plugin-owned durable continuation values and official DSH runtime ports. */
/** Fixed, secret-free diagnoses for an invalid terminal claim. */
export const TASK_CONTINUATION_INVALID_REASONS = [
    'agent-settled-before-continuation-message',
    'dispatch-evidence-before-owned-call',
    'dispatch-evidence-content-mismatch',
    'dispatch-lease-missing',
    'dispatched-inbox-evidence-missing',
    'duplicate-dispatch-evidence-before-claim',
    'newer-direct-user-message-after-dispatch',
    'original-user-message-missing',
    'verifier-echo-mismatch',
];
//# sourceMappingURL=types.js.map
