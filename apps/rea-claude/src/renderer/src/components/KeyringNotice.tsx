import { PRODUCT_NAME } from "@shared/config";
import { usePersistenceStatus } from "../hooks/usePersistenceStatus";

/** Shown only when the OS keyring is unavailable. */
export function KeyringNotice({ surface }: { surface: "gate" | "settings" }) {
  const mode = usePersistenceStatus();
  if (mode !== "none-no-keyring") return null;
  return (
    <p className={`keyring-note keyring-note--${surface}`}>
      {`Your system keyring isn’t available, so ${PRODUCT_NAME} can’t remember this sign-in — you’ll need to sign in again next launch.`}
    </p>
  );
}
