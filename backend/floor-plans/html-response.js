// Some public portfolio endpoints serve HTML fragments as text/plain.
export function isHtmlPageResponse(response) {
 const type=String(response.headers?.contentType||'').split(';',1)[0].trim().toLowerCase();
 if(type==='text/html'||type==='application/xhtml+xml') return true;
 if(type!=='text/plain'||!response.body?.length) return false;
 const prefix=response.body.toString('utf8',0,4096);
 return /^\s*(?:<!--[\s\S]*?-->\s*)*(?:<!doctype\s+html\b|<(?:html|head|body|main|article|section|div|table|h[1-6]|p|ul|ol|span|a)\b)/i.test(prefix);
}
