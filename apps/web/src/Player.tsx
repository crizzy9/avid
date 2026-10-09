import { useState, useSyncExternalStore } from 'react';
import { Play, Pause, RotateCcw, RotateCw, List, Timer, BookmarkPlus, Headphones } from 'lucide-react';
import { PlaybackController } from '../../../packages/playback/src';
import type { Book } from '../../../packages/core/src/types';
import { Cover, formatTime } from './ui';

export function Player({controller,book,onNote}:{controller:PlaybackController;book:Book;onNote:()=>void}) {
  const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot);const [chapters,setChapters]=useState(false);
  const chapterList=controller.getBook()?.chapters??[];
  return <div className="player-view"><div className="player-art"><Cover book={book} large/></div><div className="eyebrow"><Headphones size={13}/> NOW LISTENING</div><h2>{book.title}</h2><p>{book.authors.join(', ')}</p>
    <p className="player-chapter">{chapterList[state.chapterIndex]?.title||'Audio'}{book.id.startsWith('demo-')?' · Avid narration sample':''}</p>
    <input className="audio-range" aria-label="Audio position" type="range" min="0" max={state.duration||1} step=".1" value={Math.min(state.currentTime,state.duration||1)} onChange={e=>controller.seek(Number(e.target.value))}/><div className="timeline-labels"><span>{formatTime(state.currentTime)}</span><span>−{formatTime(state.duration-state.currentTime)}</span></div>
    <div className="player-transport"><button className="icon-button skip-button" onClick={()=>controller.skip(-30)} aria-label="Back 30 seconds"><RotateCcw/><small>30</small></button><button className="play-button" onClick={()=>void controller.toggle()} aria-label={state.status==='playing'?'Pause':'Play'}>{state.status==='playing'?<Pause fill="currentColor"/>:<Play fill="currentColor"/>}</button><button className="icon-button skip-button" onClick={()=>controller.skip(30)} aria-label="Forward 30 seconds"><RotateCw/><small>30</small></button></div>
    {state.error&&<div role="alert" className="error-banner">{state.error}</div>}
    <div className="player-options"><label><span>Playback speed</span><select value={state.rate} onChange={e=>controller.setRate(Number(e.target.value))}>{[.5,.75,1,1.25,1.5,1.75,2,2.5,3].map(rate=><option key={rate} value={rate}>{rate}×</option>)}</select></label><label><span><Timer size={14}/> Sleep timer</span><select aria-label="Sleep timer" value={state.sleepAtChapterEnd!==null?'chapter':state.sleepUntil!==null?'active':'off'} onChange={e=>controller.setSleepTimer(e.target.value==='off'?null:e.target.value==='chapter'?{endOfChapter:true}:{minutes:Number(e.target.value)})}><option value="off">Off</option>{state.sleepUntil&&<option value="active">Ends {new Date(state.sleepUntil).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</option>}{[5,10,15,30,45,60].map(n=><option value={n} key={n}>{n} minutes</option>)}{chapterList.length>0&&<option value="chapter">End of chapter</option>}</select></label></div>
    <div className="player-bottom"><button className="text-button" onClick={onNote}><BookmarkPlus size={18}/> Add note</button><button className="text-button" onClick={()=>setChapters(!chapters)}><List size={18}/> {chapters?'Hide chapters':'Chapters'}</button></div>
    {chapters&&<div className="chapter-list">{chapterList.length?chapterList.map(chapter=><button key={chapter.id} onClick={()=>controller.goToChapter(chapter.id)} className={chapterList[state.chapterIndex]?.id===chapter.id?'active':''}><span>{chapter.title}</span><small>{formatTime(chapter.start)}</small></button>):<p>This file has no embedded chapter information.</p>}</div>}
  </div>;
}
