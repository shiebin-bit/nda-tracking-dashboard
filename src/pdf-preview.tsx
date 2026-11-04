import {useEffect,useId,useRef,useState,type RefObject} from 'react';
import {BookOpen,MousePointer2} from 'lucide-react';

// PDF viewers own wheel/touch events. Keep them passive until the user chooses to read.
export function PdfPreview({src,title,className,iframeRef}:{src:string;title:string;className:string;iframeRef?:RefObject<HTMLIFrameElement|null>}){
  const [reading,setReading]=useState(false);
  const fallback=useRef<HTMLIFrameElement>(null);
  const frame=iframeRef??fallback;
  const activateButton=useRef<HTMLButtonElement>(null);
  const id=useId();
  useEffect(()=>setReading(false),[src]);
  const activate=()=>{setReading(true);requestAnimationFrame(()=>frame.current?.focus({preventScroll:true}));};
  const finish=()=>{setReading(false);requestAnimationFrame(()=>activateButton.current?.focus({preventScroll:true}));};
  return <div className={`pdf-preview ${reading?'is-reading':''}`} onPointerLeave={event=>{if(event.pointerType==='mouse')setReading(false);}}>
    <div className="pdf-preview-mode"><span>{reading?'Reading PDF':'Preview · page scrolling'}</span>{reading&&<button type="button" className="text-button" aria-controls={id} aria-label={`Return to page scrolling for ${title}`} onClick={finish}>Done reading</button>}</div>
    <div className="pdf-preview-surface">
      <iframe ref={frame} id={id} title={title} className={className} src={src} tabIndex={reading?0:-1} inert={!reading}/>
      {!reading&&<button ref={activateButton} type="button" className="pdf-preview-activate" aria-label={`Read ${title}`} aria-controls={id} onClick={activate}><span><BookOpen size={17}/><strong>Read PDF</strong><small>Click to use PDF controls</small></span></button>}
    </div>
    {reading&&<p className="pdf-preview-hint"><MousePointer2 size={13}/>Move outside the preview or choose Done reading to scroll the page.</p>}
  </div>;
}
