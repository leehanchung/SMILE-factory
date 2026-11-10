import { useEffect, useState } from "react";
import { avatarUrl } from "../lib/urls";

/** GitHub avatar; renders nothing without a login or after a load error. */
export function Avatar({ login, size = 32 }: { login: string | undefined; size?: number }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [login]);
  if (failed || !login) return null;
  return (
    <img
      className="avatar"
      src={avatarUrl(login, size)}
      alt=""
      width={size}
      height={size}
      onError={() => setFailed(true)}
    />
  );
}
