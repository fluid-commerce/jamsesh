// What the dev proxy adds to the pages it forwards, so the person driving the big screen (SPEC 10.6) can click,
// scroll and type in a live build. The big screen can't reach into a page on another port, so it posts
// {jamDrive: event, key} to the frame and this script replays it as DOM events there: only from the host's
// big screen (its exact origin) with the session's frame key, never from another page that frames the build.
import { createHash } from "node:crypto";

/**
 * The script the dev proxy puts first in every page it serves (6.1), which replays a driver's clicks, scrolls and
 * typing. It takes input only from the host's own big screen: messages from exactly `hostOrigin` (scheme, host and
 * port) that carry the session's frame key, whose SHA-256 is `keyHash` (the page, which anyone who can load it can
 * read, holds only the hash). The big screen sends only the events the hub passed on from a screen's drivers.
 */
export function driveScript(hostOrigin: string, keyHash: string): string {
  return `(function(){
if(window.__jamDrive||window.parent===window)return;window.__jamDrive=1;
var O=${JSON.stringify(hostOrigin)},H=${JSON.stringify(keyHash)},good=null,q=Promise.resolve();
function hex(d){return [].map.call(new Uint8Array(d),function(b){return('0'+b.toString(16)).slice(-2)}).join('')}
function trusted(k){if(good!==null)return k===good;if(!window.crypto||!crypto.subtle)return false;return crypto.subtle.digest('SHA-256',new TextEncoder().encode(k)).then(function(d){if(hex(d)!==H)return false;good=k;return true})}
var over=null,S={},tm=0;
function st(w){return S[w]||(S[w]={b:0,el:null,x:0,y:0,k:{}})}
function btns(){var n=0;for(var w in S)n|=S[w].b;return n}
function pt(e){var x=e.x*innerWidth,y=e.y*innerHeight;return{x:x,y:y,el:document.elementFromPoint(x,y)||document.body}}
function opts(p,b,extra){var o={bubbles:true,cancelable:true,composed:true,view:window,clientX:p.x,clientY:p.y,screenX:p.x,screenY:p.y,button:b||0,buttons:btns(),pointerId:1,pointerType:'mouse',isPrimary:true};for(var k in extra)o[k]=extra[k];return o}
function fire(t,type,o){var C=type.indexOf('pointer')===0&&window.PointerEvent?PointerEvent:MouseEvent;var e=new C(type,o);t.dispatchEvent(e);return e}
function focusable(el){return el&&el.closest&&el.closest('input,textarea,select,button,a[href],[tabindex],[contenteditable=""],[contenteditable="true"]')}
function editable(el){return el&&(el.isContentEditable||(el.tagName==='TEXTAREA')||(el.tagName==='INPUT'&&!/^(button|submit|checkbox|radio|reset|file|image|range|color)$/.test(el.type)))}
function hover(p){if(over!==p.el){if(over){fire(over,'pointerout',opts(p));fire(over,'mouseout',opts(p,0,{relatedTarget:p.el}))}fire(p.el,'pointerover',opts(p));fire(p.el,'mouseover',opts(p,0,{relatedTarget:over}));over=p.el}}
function scroller(el,dx,dy){for(var n=el;n&&n!==document.body&&n!==document.documentElement;n=n.parentElement){var s=getComputedStyle(n),y=/(auto|scroll)/.test(s.overflowY)&&n.scrollHeight>n.clientHeight&&dy,x=/(auto|scroll)/.test(s.overflowX)&&n.scrollWidth>n.clientWidth&&dx;if(x||y)return n}return document.scrollingElement||document.documentElement}
function key(e){
var a=document.activeElement&&document.activeElement!==document.body?document.activeElement:null,t=a||document.body,m=e.mods||{};
var k=new KeyboardEvent(e.down?'keydown':'keyup',{key:e.key,code:e.code||'',bubbles:true,cancelable:true,composed:true,shiftKey:!!m.shift,ctrlKey:!!m.ctrl,altKey:!!m.alt,metaKey:!!m.meta});
var go=t.dispatchEvent(k);if(!e.down||!go)return;
if(editable(a)){
if(e.key.length===1&&!m.ctrl&&!m.meta)return void document.execCommand('insertText',false,e.key);
if(e.key==='Backspace')return void document.execCommand('delete');
if(e.key==='Delete')return void document.execCommand('forwardDelete');
if(e.key==='Enter'){if(a.tagName==='TEXTAREA'||a.isContentEditable)return void document.execCommand('insertLineBreak');var f=a.form;return void(f&&(f.requestSubmit?f.requestSubmit():f.submit()))}
if(a.setSelectionRange&&/^Arrow(Left|Right)$/.test(e.key)){var d=e.key==='ArrowLeft'?-1:1,s=(d<0?a.selectionStart:a.selectionEnd)+d;s=Math.max(0,Math.min(a.value.length,s));return void a.setSelectionRange(s,s)}
if(e.key==='Home'||e.key==='End'){if(a.setSelectionRange){var q=e.key==='Home'?0:a.value.length;a.setSelectionRange(q,q)}return}
}
if(e.key==='Tab'){var all=[].slice.call(document.querySelectorAll('input,textarea,select,button,a[href],[tabindex]:not([tabindex="-1"])')).filter(function(n){return !n.disabled&&n.offsetParent!==null}),i=all.indexOf(a)+(m.shift?-1:1);var n=all[(i+all.length)%all.length];return void(n&&n.focus())}
if((e.key==='Enter'||e.key===' ')&&a&&/^(BUTTON|A|SUMMARY)$/.test(a.tagName))return void a.click();
var step={ArrowDown:[0,48],ArrowUp:[0,-48],PageDown:[0,innerHeight*.9],PageUp:[0,-innerHeight*.9],' ':[0,m.shift?-innerHeight*.9:innerHeight*.9],ArrowRight:[48,0],ArrowLeft:[-48,0]}[e.key];
if(step)scroller(t,step[0],step[1]).scrollBy({left:step[0],top:step[1],behavior:'instant'});
if(e.key==='Home'||e.key==='End')(document.scrollingElement||document.documentElement).scrollTo({top:e.key==='Home'?0:1e9,behavior:'instant'});
}
function kev(t,type,k,h){t.dispatchEvent(new KeyboardEvent(type,{key:k,code:h.code,bubbles:true,cancelable:true,composed:true,shiftKey:!!h.mods.shift,ctrlKey:!!h.mods.ctrl,altKey:!!h.mods.alt,metaKey:!!h.mods.meta}))}
function rel(w){var s=S[w];if(!s)return;var p=pt({x:s.x,y:s.y});for(var b=0;b<3;b++)if(s.b&(1<<b)){s.b&=~(1<<b);fire(p.el,'pointerup',opts(p,b));fire(p.el,'mouseup',opts(p,b))}
s.el=null;var a=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.body;for(var k in s.k)kev(a,'keyup',k,s.k[k]);s.k={}}
function arm(){clearTimeout(tm);var held=false;for(var w in S){var s=S[w];if(s.b||Object.keys(s.k).length)held=true}if(held)tm=setTimeout(function(){for(var w in S)rel(w)},8000)}
function apply(e,w){
var s=st(w);
if(e.k==='key'){if(e.down)s.k[e.key]={code:e.code||'',mods:e.mods||{}};else delete s.k[e.key];return key(e)}
if(e.k==='leave'){rel(w);if(over){fire(over,'mouseout',opts({x:0,y:0}));over=null}return}
var p=pt(e);
if(e.k==='move'){if(s.b){s.x=e.x;s.y=e.y}hover(p);fire(p.el,'pointermove',opts(p));fire(p.el,'mousemove',opts(p))}
else if(e.k==='down'){hover(p);s.b|=1<<(e.b||0);s.el=p.el;s.x=e.x;s.y=e.y;fire(p.el,'pointerdown',opts(p,e.b));var d=fire(p.el,'mousedown',opts(p,e.b,{detail:e.n||1}));var f=focusable(p.el);if(!d.defaultPrevented){if(f){f.focus();if(editable(f)&&f.setSelectionRange&&!f.selectionStart&&f.value)f.setSelectionRange(f.value.length,f.value.length)}else if(document.activeElement&&document.activeElement.blur)document.activeElement.blur()}}
else if(e.k==='up'){s.b&=~(1<<(e.b||0));var downEl=s.el;fire(p.el,'pointerup',opts(p,e.b));fire(p.el,'mouseup',opts(p,e.b,{detail:e.n||1}));if(downEl&&(downEl===p.el||downEl.contains(p.el)||p.el.contains(downEl))){var t=downEl.contains(p.el)?downEl:p.el;if(!e.b)fire(t,'click',opts(p,0,{detail:e.n||1}));else if(e.b===2)fire(t,'contextmenu',opts(p,2));if(e.n===2&&!e.b)fire(t,'dblclick',opts(p,0,{detail:2}))}s.el=null}
else if(e.k==='wheel'){hover(p);var w=new WheelEvent('wheel',opts(p,0,{deltaX:e.dx||0,deltaY:e.dy||0,deltaMode:0,ctrlKey:!!e.ctrl}));p.el.dispatchEvent(w);if(!w.defaultPrevented&&!e.ctrl)scroller(p.el,e.dx,e.dy).scrollBy({left:e.dx||0,top:e.dy||0,behavior:'instant'})}
}
addEventListener('message',function(m){
if(m.source!==parent||m.origin!==O||!m.data||!m.data.jamDrive||typeof m.data.key!=='string')return;
var e=m.data.jamDrive,k=m.data.key,w=typeof m.data.who==='string'?m.data.who.slice(0,64):'';
q=q.then(function(){return trusted(k)}).then(function(ok){if(ok){apply(e,w);arm()}}).catch(function(){});
});
try{parent.postMessage({jamDriveReady:1},O)}catch(e){}
})();`;
}

/** The value a Content-Security-Policy names a script by. */
export const scriptHash = (script: string) => `'sha256-${createHash("sha256").update(script).digest("base64")}'`;

const META_CSP = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/i;

/**
 * The page with the driving script as its first script (nothing else changes). It goes in before any
 * `<meta http-equiv="Content-Security-Policy">`, which applies only to what follows it; the page's header
 * policy is widened by its hash instead (`allowDriveScript`).
 */
export function withDriveScript(html: string, script: string): string {
  const tag = `<script>${script}</script>`;
  const at = (i: number) => html.slice(0, i) + tag + html.slice(i);
  const head = html.match(/<head\b[^>]*>/i);
  const meta = html.match(META_CSP);
  if (meta?.index !== undefined && (head?.index === undefined || meta.index < head.index + head[0].length)) return at(meta.index);
  if (head?.index !== undefined) return at(head.index + head[0].length);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? at(doctype[0].length) : tag + html;
}

/**
 * A Content-Security-Policy header that also lets the driving script (`hash`) run. An inline script is governed by
 * script-src-elem, else script-src, else default-src: the hash joins each of those the policy has (the first two),
 * or default-src when it has neither. A directive that already allows inline scripts is left alone (a hash would
 * turn its 'unsafe-inline' off). Several policies (a comma-joined header) are each widened.
 */
export function allowDriveScript(csp: string, hash: string): string {
  return csp
    .split(",")
    .map((policy) => {
      const parts = policy.split(";").map((p) => p.trim()).filter(Boolean);
      const named = (re: RegExp) => parts.findIndex((p) => re.test(p));
      const elem = named(/^script-src-elem(\s|$)/i);
      const src = named(/^script-src(\s|$)/i);
      const which = elem >= 0 || src >= 0 ? [elem, src].filter((i) => i >= 0) : [named(/^default-src(\s|$)/i)].filter((i) => i >= 0);
      for (const i of which) if (!/'unsafe-inline'/i.test(parts[i]) || /'(nonce|sha\d+)-/i.test(parts[i])) parts[i] = `${parts[i]} ${hash}`;
      return parts.join("; ");
    })
    .join(", ");
}
