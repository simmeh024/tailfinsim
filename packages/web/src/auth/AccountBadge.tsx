import { useSession } from './SessionProvider';

import type { ReactNode } from 'react';

/**
 * Who you are, in the left rail (M0-11, narrowed in M0-12).
 *
 * Signed-in state only. `RequireSession` means the shell never renders without a
 * session, so the sign-in link and the error message moved to `LoginPage` rather
 * than staying here as branches that can no longer be reached. One place shows
 * "sign in"; one place shows "who you are".
 */
export function AccountBadge(): ReactNode {
  const { player, signOut } = useSession();
  if (!player) return null;

  return (
    <div className="account">
      <div className="account__player">
        {player.avatarUrl === null ? (
          <span className="account__avatar account__avatar--empty" aria-hidden="true">
            {player.displayName.slice(0, 1).toUpperCase()}
          </span>
        ) : (
          <img
            className="account__avatar"
            src={player.avatarUrl}
            alt=""
            width={28}
            height={28}
            // The avatar is hosted by Google; do not tell them which page it was
            // loaded from.
            referrerPolicy="no-referrer"
          />
        )}
        <span className="account__name">{player.displayName}</span>
      </div>

      <button type="button" className="account__signout" onClick={() => void signOut()}>
        Sign out
      </button>
    </div>
  );
}
