(function(){
if(window.__cdbStickBottom)return;
window.__cdbStickBottom=true;

// How close to the bottom still counts as "following the stream".
// The SPA itself uses a 1px sentinel, which a sub-pixel layout drift defeats;
// a band of a few lines is what makes this robust.
var BAND=64;
// Roots whose transcript scroller should follow new content. Both the main
// Code/Cowork transcript and the floating side chat live under these.
var ROOTS=[".epitaxy-chat-panel-body",".epitaxy-side-chat"];
// A remounted pane only has to be picked up "soon", and sweeping costs a style
// recalc, so it is throttled rather than run on every mutation of a live stream.
var SWEEP_MS=250;

var states=new WeakMap();

function dist(el){return el.scrollHeight-el.scrollTop-el.clientHeight}

function scrollers(root){
  var out=[],all=root.querySelectorAll("div,section,ul");
  for(var i=0;i<all.length;i++){
    var el=all[i],cs=getComputedStyle(el);
    if(cs.overflowY!=="auto"&&cs.overflowY!=="scroll")continue;
    if(el.clientHeight<80)continue;
    // The composer is a scrollable box too - never touch it.
    if(String(el.className||"").indexOf("ProseMirror")>=0)continue;
    out.push(el);
  }
  return out;
}

// Coalesce to one layout read + write per frame. Streaming text produces many
// mutation batches, and reading scrollHeight in each one would force a sync
// reflow every time. Re-checking `pinned` inside the frame also means a gesture
// that arrives after we scheduled still cancels the scroll.
function schedule(el){
  var s=states.get(el);
  if(!s||!s.pinned||s.raf)return;
  s.raf=requestAnimationFrame(function(){
    s.raf=0;
    if(!s.pinned)return;
    if(dist(el)>0)el.scrollTop=el.scrollHeight;
  });
}

function attach(el){
  if(states.has(el))return;
  var s={pinned:dist(el)<=BAND,raf:0,ro:null,mo:null};
  states.set(el,s);

  // Re-evaluate on every scroll: inside the band we follow the stream, outside
  // it we stay out of the way. This needs no "was it us?" bookkeeping - our own
  // scroll lands at dist 0, which is inside the band, so it re-affirms the state
  // it was already in, while a real scroll away from the bottom clears it.
  el.addEventListener("scroll",function(){
    s.pinned=dist(el)<=BAND;
  },{passive:true});

  // Scroll events are delivered asynchronously, so a mutation landing in the
  // same frame as the user's gesture would still see the old state and yank
  // them back down. Wheel/touch/key handlers run synchronously, so an upward
  // gesture unpins immediately and always wins over a scheduled scroll.
  el.addEventListener("wheel",function(e){
    if(e.deltaY<0)s.pinned=false;
  },{passive:true});
  el.addEventListener("touchmove",function(){
    if(dist(el)>BAND)s.pinned=false;
  },{passive:true});
  el.addEventListener("keydown",function(e){
    var k=e.key;
    if(k==="PageUp"||k==="ArrowUp"||k==="Home")s.pinned=false;
  },true);

  var content=el.firstElementChild;
  if(content&&typeof ResizeObserver==="function"){
    s.ro=new ResizeObserver(function(){schedule(el)});
    s.ro.observe(content);
  }
  s.mo=new MutationObserver(function(){schedule(el)});
  s.mo.observe(el,{childList:true,subtree:true,characterData:true});

  schedule(el);
}

function sweep(){
  for(var i=0;i<ROOTS.length;i++){
    var roots=document.querySelectorAll(ROOTS[i]);
    for(var j=0;j<roots.length;j++){
      var list=scrollers(roots[j]);
      for(var k=0;k<list.length;k++)attach(list[k]);
    }
  }
}

var sweepTimer=0;
function queueSweep(){
  if(sweepTimer)return;
  sweepTimer=setTimeout(function(){sweepTimer=0;sweep()},SWEEP_MS);
}

sweep();
// The SPA remounts these panes on navigation, so keep looking for new ones.
new MutationObserver(queueSweep).observe(document.documentElement,{childList:true,subtree:true});

try{
  (window.__cdbDiag||function(){})("[epitaxy-autoscroll] installed, band="+BAND+"px");
}catch(e){}
})()
