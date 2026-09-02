import sanitizeHtml from "sanitize-html";

/**
 * Strict allowlist for email HTML. No <script>, no event-handler attributes,
 * no javascript: URLs. Applied at render time, not on save.
 */
export function sanitizeEmailHtml(dirty: string): string {
  return sanitizeHtml(dirty, {
    allowedTags: [
      "a", "b", "blockquote", "br", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
      "hr", "i", "img", "li", "ol", "p", "pre", "small", "span", "strong", "table",
      "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "center", "font",
    ],
    allowedAttributes: {
      a: ["href", "name", "target", "rel", "style"],
      img: ["src", "alt", "width", "height", "style"],
      "*": ["style", "align", "valign", "bgcolor", "width", "height", "class"],
      font: ["color", "face", "size"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
      table: ["cellpadding", "cellspacing", "border", "role"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesByTag: { img: ["http", "https", "data", "cid"] },
    allowProtocolRelative: false,
    transformTags: {
      a: (tagName, attribs) => ({
        tagName,
        attribs: { ...attribs, rel: "noopener noreferrer" },
      }),
    },
  });
}
