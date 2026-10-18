import {themeColors,type ReaderSettings} from './contracts';
import {fontRules} from './fonts';
/** Formatting remains in the isolated EPUB document; this only controls reader overrides. */
export function publicationStyleRules(settings:ReaderSettings,activeClass='avid-narration-active',scope='local'):string {
  const highlight=`::selection { background: #d9b97188; } .${CSS.escape(activeClass)}, .avid-audio-active { background: #d6b96e88 !important; color: inherit !important; }`;
  if(settings.publicationStyles===true)return highlight;
  const colors=themeColors(settings),family=settings.font.replace(/["\\;{}]/g,'');
  return `${fontRules(scope)} html { color: ${colors.foreground}; background: ${colors.background}; } body { font-family: "${family}", Georgia, serif !important; font-size: ${settings.fontSize}px !important; line-height: ${settings.lineHeight} !important; } p { line-height: inherit !important; } h1, h2 { line-height: 1.3; font-weight: 500; } a { color: inherit; } img { max-width:100%; } ${highlight}`;
}
