/** Only explicit BookOrbit online voices use this namespace. Browser voices can also be remote. */
export function isOnlineBookOrbitVoice(voiceURI:string):boolean{return voiceURI.startsWith('avid-online:');}
