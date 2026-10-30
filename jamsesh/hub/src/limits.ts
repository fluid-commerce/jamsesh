// Sizes that more than one place has to agree on.

/** The largest screenshot a hub keeps (PNG or JPEG), however it arrives. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
/** The largest JSON body on /mcp: a base64 image at the limit (4 bytes for every 3), plus the rest of the request. */
export const MCP_BODY_BYTES = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 256 * 1024;
