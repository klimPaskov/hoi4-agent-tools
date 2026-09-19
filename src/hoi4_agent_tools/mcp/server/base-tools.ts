/** Compatibility names for the protocol-independent execution authorization boundary. */
export {
  requireOperationScope as requireServerScope,
  resolveOperationWorkspaceForSource as resolveServerWorkspaceForSource,
  resolveOperationWorkspaceId as resolveServerWorkspaceId,
  type OperationContext as ServerContext,
} from '../../core/operation-context.js';
export { postValidateTransaction } from '../../core/domain-validation.js';
