import {describe,expect,it} from 'vitest';
import {pdfLayout,pdfOutputRatio,pdfSelectionRectangles,savedPdfRectangles} from './pdfGeometry';
const none={top:0,right:0,bottom:0,left:0};
describe('PDF page and text coordinates',()=>{
  it('fills the actual viewport width without a desktop cap and supports whole-page fit',()=>{
    const page={width:600,height:800},available={width:1400,height:900};
    expect(pdfLayout(page,available,none,'width')).toMatchObject({width:1400,visibleWidth:1400});
    const fit=pdfLayout(page,available,none,'page');
    expect(fit.width).toBe(675);expect(fit.height).toBe(900);
    expect(pdfLayout({width:800,height:600},available,none,'page').width).toBe(1200);
  });
  it('refits the visible cropped region while keeping rectangles relative to the full page',()=>{
    const crop={top:.1,right:.1,bottom:.1,left:.1};
    const layout=pdfLayout({width:600,height:800},{width:960,height:800},crop,'width');
    expect(layout).toEqual({scale:2,width:1200,height:1600,visibleWidth:960,visibleHeight:1280,left:120,top:160});
    const original=pdfSelectionRectangles([{left:120,top:180,width:60,height:20}],{left:0,top:100,width:600,height:800});
    // The cropped page is offset inside its clip. DPR does not enter DOM/CSS coordinates.
    const afterCrop=pdfSelectionRectangles([{left:120,top:100,width:120,height:40}],{left:-120,top:-60,width:1200,height:1600});
    expect(original).toEqual(afterCrop);
    expect(original).toEqual([{x:.2,y:.1,width:.1,height:.025}]);
  });
  it('keeps separate lines, clips out-of-page areas and rejects empty/nonfinite rectangles',()=>{
    const a={left:10,top:20,width:60,height:10};
    expect(pdfSelectionRectangles([a,a,{left:10,top:30,width:20,height:10},{left:-10,top:0,width:20,height:10},{left:NaN,top:2,width:2,height:2},{left:2,top:2,width:0,height:4},{left:110,top:2,width:2,height:2}],{left:0,top:0,width:100,height:100})).toEqual([
      {x:.1,y:.2,width:.6,height:.1},{x:.1,y:.3,width:.2,height:.1},{x:0,y:0,width:.1,height:.1},
    ]);
  });
  it('does not paint malformed or other-page highlights',()=>{
    const good={x:.1,y:.2,width:.3,height:.04},locator=JSON.stringify({page:2,rectangles:[good,{...good,width:-1},{...good,x:1},{...good,y:'0.2'},null]});
    expect(savedPdfRectangles(locator,2)).toEqual([good]);expect(savedPdfRectangles(locator,1)).toEqual([]);expect(savedPdfRectangles('{',2)).toEqual([]);
  });
  it('bounds canvas memory without changing CSS page size or selection locations',()=>{
    expect(pdfOutputRatio(600,800,3)).toBe(2);
    const ratio=pdfOutputRatio(10000,20000,3);
    expect(10000*20000*ratio**2).toBeLessThanOrEqual(16_000_001);expect(20000*ratio).toBeLessThanOrEqual(8192);
    expect(()=>pdfLayout({width:600,height:800},{width:400,height:600},{...none,left:.6},'width')).toThrow();
  });
});
