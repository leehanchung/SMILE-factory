/** SSH config alias for a newly entered host [renderer §6]. */

export function sshAliasFor(deploymentId: string, hostName: string): string {
  const slug = (deploymentId || hostName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `silico-${slug || "host"}`;
}
