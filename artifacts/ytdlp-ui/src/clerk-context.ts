import { createContext } from 'react';

/** True only when <ClerkProvider> is mounted above in the tree.
 *  Components that call Clerk hooks MUST be conditionally rendered on this value. */
export const ClerkEnabledCtx = createContext(false);
