import { useState } from 'react';

/** Small device preferences only. Credentials and book content never use localStorage. */
export function useLocalState<T>(key:string,initial:T):[T,(next:T|((previous:T)=>T))=>void] {
  const [value,setValue]=useState<T>(()=>{try{const stored=localStorage.getItem(`avid:${key}`);return stored?JSON.parse(stored) as T:initial;}catch{return initial;}});
  return [value,(next)=>setValue(previous=>{const result=typeof next==='function'?(next as (v:T)=>T)(previous):next;try{localStorage.setItem(`avid:${key}`,JSON.stringify(result));}catch{/* The UI remains usable when browser storage is denied. */}return result;})];
}
