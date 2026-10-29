// What the dev proxy adds to the pages it forwards, so the person driving the big screen (SPEC 10.6) can click,
// scroll and type in a live build. The big screen can't reach into a page on another port, so it posts
// {jamDrive: event} to the frame and this script replays it as DOM events there. It only listens to the page
// that framed it, and only when that page is on the same host name (the dev port's own host, or the hub's).
import { createHash } from "node:crypto";

export const DRIVE_SCRIPT = `(function(){
if(window.__jamDrive||window.parent===window)return;window.__jamDrive=1;
function lo(h){return /^(localhost|127\\.0\\.0\\.1|\\[::1\\])$/.test(h)?'loopback':h}
function ok(o){try{var h=lo(new URL(o).hostname),l=lo(location.hostname);return h===l||l.slice(-h.length-1)==='.'+h}catch(e){return false}}
var over=null,downEl=null,btns=0;
function pt(e){var x=e.x*innerWidth,y=e.y*innerHeight;return{x:x,y:y,el:document.elementFromPoint(x,y)||document.body}}
function opts(p,b,extra){var o={bubbles:true,cancelable:true,composed:true,view:window,clientX:p.x,clientY:p.y,screenX:p.x,screenY:p.y,button:b||0,buttons:btns,pointerId:1,pointerType:'mouse',isPrimary:true};for(var k in extra)o[k]=extra[k];return o}
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
addEventListener('message',function(m){
if(m.source!==parent||!ok(m.origin)||!m.data||!m.data.jamDrive)return;
var e=m.data.jamDrive;if(e.k==='key')return key(e);
if(e.k==='leave'){if(over){fire(over,'mouseout',opts({x:0,y:0}));over=null}return}
var p=pt(e);
if(e.k==='move'){hover(p);fire(p.el,'pointermove',opts(p));fire(p.el,'mousemove',opts(p))}
else if(e.k==='down'){hover(p);btns|=1<<(e.b||0);downEl=p.el;fire(p.el,'pointerdown',opts(p,e.b));var d=fire(p.el,'mousedown',opts(p,e.b,{detail:e.n||1}));var f=focusable(p.el);if(!d.defaultPrevented){if(f){f.focus();if(editable(f)&&f.setSelectionRange&&!f.selectionStart&&f.value)f.setSelectionRange(f.value.length,f.value.length)}else if(document.activeElement&&document.activeElement.blur)document.activeElement.blur()}}
else if(e.k==='up'){btns&=~(1<<(e.b||0));fire(p.el,'pointerup',opts(p,e.b));fire(p.el,'mouseup',opts(p,e.b,{detail:e.n||1}));if(downEl&&(downEl===p.el||downEl.contains(p.el)||p.el.contains(downEl))){var t=downEl.contains(p.el)?downEl:p.el;if(!e.b)fire(t,'click',opts(p,0,{detail:e.n||1}));else if(e.b===2)fire(t,'contextmenu',opts(p,2));if(e.n===2&&!e.b)fire(t,'dblclick',opts(p,0,{detail:2}))}downEl=null}
else if(e.k==='wheel'){hover(p);var w=new WheelEvent('wheel',opts(p,0,{deltaX:e.dx||0,deltaY:e.dy||0,deltaMode:0,ctrlKey:!!e.ctrl}));p.el.dispatchEvent(w);if(!w.defaultPrevented&&!e.ctrl)scroller(p.el,e.dx,e.dy).scrollBy({left:e.dx||0,top:e.dy||0,behavior:'instant'})}
});
try{parent.postMessage({jamDriveReady:1},'*')}catch(e){}
})();`;

/** Hash of the script, for a page whose Content-Security-Policy would otherwise stop it. */
const HASH = `'sha256-${createHash("sha256").update(DRIVE_SCRIPT).digest("base64")}'`;

/** The page with the driving script as its first script (nothing else changes), or the page as it was if it isn't an HTML document. */
export function withDriveScript(html: string): string {
  const tag = `<script>${DRIVE_SCRIPT}</script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head?.index !== undefined) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  return doctype ? doctype[0] + tag + html.slice(doctype[0].length) : tag + html;
}

/** A Content-Security-Policy that also lets the driving script run: the hash joins script-src (or default-src when there's none). */
export function allowDriveScript(csp: string): string {
  const parts = csp.split(";").map((p) => p.trim()).filter(Boolean);
  const pick = parts.findIndex((p) => /^script-src\s/i.test(p)) >= 0 ? /^script-src\s/i : /^default-src\s/i;
  const i = parts.findIndex((p) => pick.test(p));
  if (i < 0) return csp;
  if (/'unsafe-inline'/.test(parts[i]) && !/'(nonce|sha\d+)-/.test(parts[i])) return csp;
  parts[i] = `${parts[i]} ${HASH}`;
  return parts.join("; ");
}
