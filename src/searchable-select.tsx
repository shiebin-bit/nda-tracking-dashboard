import {useEffect,useId,useMemo,useRef,useState} from 'react';
import {ChevronDown,X} from 'lucide-react';
import './searchable-select.css';

export interface SearchOption {value:string;label:string;search?:string[]}
export function searchOptions(options:SearchOption[],query:string):SearchOption[]{
  const term=query.trim().normalize('NFKC').toLocaleLowerCase();
  if(!term)return options;
  return options.map((option,index)=>{
    const words=[option.label,...option.search??[]].map(value=>value.normalize('NFKC').toLocaleLowerCase());
    return {option,index,rank:words.some(value=>value.startsWith(term))?0:words.some(value=>value.includes(term))?1:2};
  }).filter(item=>item.rank<2).sort((a,b)=>a.rank-b.rank||a.index-b.index).map(item=>item.option);
}

/** Text is a search query until an option is explicitly chosen. */
export function SearchableSelect({label,value,options,onChange,disabled=false,clearValue='',placeholder='Search by ID or name…'}:{
  label:string;value:string;options:SearchOption[];onChange:(value:string)=>void;disabled?:boolean;clearValue?:string;placeholder?:string;
}){
  const id=useId();const root=useRef<HTMLDivElement>(null);const input=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false);const [query,setQuery]=useState<string|null>(null);const [active,setActive]=useState(0);
  const matches=useMemo(()=>searchOptions(options,query??''),[options,query]);
  const selected=options.find(option=>option.value===value);
  useEffect(()=>{if(disabled){setOpen(false);setQuery('');}},[disabled]);
  useEffect(()=>{const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node)){setOpen(false);setQuery('');}};document.addEventListener('pointerdown',outside);return()=>document.removeEventListener('pointerdown',outside);},[]);
  const show=()=>{if(disabled)return;setQuery(null);setActive(Math.max(0,options.findIndex(option=>option.value===value)));setOpen(true);requestAnimationFrame(()=>input.current?.select());};
  const choose=(next:string)=>{onChange(next);setQuery('');setOpen(false);input.current?.focus();};
  const index=Math.min(active,Math.max(0,matches.length-1));
  useEffect(()=>{if(open)document.getElementById(`${id}-option-${index}`)?.scrollIntoView({block:'nearest'});},[open,index,id,query]);
  return <div className="searchable-select" ref={root}>
    <div className="searchable-select-control"><input ref={input} role="combobox" aria-label={label} aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open&&matches.length?`${id}-option-${index}`:undefined} disabled={disabled} placeholder={placeholder} value={open?(query??selected?.label??''):selected?.label??''}
      onFocus={show} onClick={()=>{if(!open)show();}} onChange={event=>{setQuery(event.target.value);setOpen(true);setActive(0);}}
      onBlur={event=>{if(!root.current?.contains(event.relatedTarget as Node)){setOpen(false);setQuery('');}}}
      onKeyDown={event=>{
        if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(!open){show();return;}setActive(Math.max(0,Math.min(matches.length-1,index+(event.key==='ArrowDown'?1:-1))));}
        else if(event.key==='Enter'&&open){event.preventDefault();if(matches[index])choose(matches[index].value);}
        else if(event.key==='Escape'){event.preventDefault();setOpen(false);setQuery('');}
        else if(event.key==='Tab'){setOpen(false);setQuery('');}
      }}/>
      {value!==clearValue&&<button type="button" className="searchable-select-clear" disabled={disabled} aria-label={`Clear ${label.toLowerCase()}`} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(clearValue)}><X size={14}/></button>}
      <button type="button" className="searchable-select-toggle" disabled={disabled} aria-label={`Show ${label.toLowerCase()} options`} onMouseDown={event=>event.preventDefault()} onClick={()=>{if(open){setOpen(false);setQuery('');}else{input.current?.focus();show();}}}><ChevronDown size={15}/></button>
    </div>
    {open&&<div className="searchable-select-popup"><ul id={`${id}-list`} role="listbox" aria-label={label}>{matches.map((option,i)=><li key={option.value} id={`${id}-option-${i}`} role="option" aria-selected={option.value===value} className={i===index?'active':''} onPointerMove={()=>setActive(i)} onMouseDown={event=>event.preventDefault()} onClick={()=>choose(option.value)}>{option.label}</li>)}</ul>{!matches.length&&<p role="status">No matches. Try another ID or name.</p>}<small>{matches.length} option{matches.length===1?'':'s'} · Select to apply</small></div>}
  </div>;
}
