import { LOGO_SRC } from "../assets/logo";

export function Logo({ className, alt = "" }: { className?: string; alt?: string }) {
  return <img className={className} src={LOGO_SRC} alt={alt} />;
}
