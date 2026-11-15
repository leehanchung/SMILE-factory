/**
 * Original placeholder mark (D6: no assets copied from the original app).
 * Inline SVG data URI so it works under the CSP (img-src data:) and in tests.
 */
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<rect x="4" y="4" width="56" height="56" rx="14" fill="#e2552d"/>' +
  '<path d="M32 13c4 8 13 13 13 25a13 13 0 0 1-26 0c0-6 3-10 6-13 0 5 2 8 5 9-1-8 0-14 2-21z" fill="#fff"/>' +
  "</svg>";

export const LOGO_SRC = `data:image/svg+xml;utf8,${encodeURIComponent(LOGO_SVG)}`;
