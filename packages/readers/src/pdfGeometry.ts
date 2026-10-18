export interface PdfCrop {top:number;right:number;bottom:number;left:number}
export interface PdfRectangle {x:number;y:number;width:number;height:number}
export function pdfLayout(page:{width:number;height:number},available:{width:number;height:number},crop:PdfCrop,fit:'width'|'page'){
  const visibleWidth=page.width*(1-crop.left-crop.right),visibleHeight=page.height*(1-crop.top-crop.bottom);
  if(![page.width,page.height,available.width,available.height,visibleWidth,visibleHeight].every(n=>Number.isFinite(n)&&n>0) || Object.values(crop).some(n=>!Number.isFinite(n)||n<0||n>.4))throw new Error('Invalid PDF page dimensions.');
  const scale=fit==='width'?available.width/visibleWidth:Math.min(available.width/visibleWidth,available.height/visibleHeight);
  return{scale,width:page.width*scale,height:page.height*scale,visibleWidth:visibleWidth*scale,visibleHeight:visibleHeight*scale,left:page.width*scale*crop.left,top:page.height*scale*crop.top};
}
/** CSS coordinates on the complete page remain stable through crop, zoom, DPR and resizing. */
export function pdfSelectionRectangles(rectangles:readonly Pick<DOMRect,'left'|'top'|'width'|'height'>[],page:Pick<DOMRect,'left'|'top'|'width'|'height'>):PdfRectangle[]{
  if(![page.left,page.top,page.width,page.height].every(Number.isFinite)||page.width<=0||page.height<=0)return[];
  const result:PdfRectangle[]=[];
  for(const rect of rectangles.slice(0,2_000)){
    if(![rect.left,rect.top,rect.width,rect.height].every(Number.isFinite)||rect.width<=0||rect.height<=0)continue;
    const left=Math.max(page.left,rect.left),top=Math.max(page.top,rect.top),right=Math.min(page.left+page.width,rect.left+rect.width),bottom=Math.min(page.top+page.height,rect.top+rect.height);
    if(right<=left||bottom<=top)continue;
    const next={x:(left-page.left)/page.width,y:(top-page.top)/page.height,width:(right-left)/page.width,height:(bottom-top)/page.height};
    if(!result.some(old=>Math.abs(old.x-next.x)<.0001&&Math.abs(old.y-next.y)<.0001&&Math.abs(old.width-next.width)<.0001&&Math.abs(old.height-next.height)<.0001))result.push(next);
  }
  return result;
}
export function savedPdfRectangles(locator:string,page:number):PdfRectangle[]{
  try{const value=JSON.parse(locator);if(value.page!==page||!Array.isArray(value.rectangles))return[];
    return value.rectangles.slice(0,2_000).filter((r:PdfRectangle)=>r&&[r.x,r.y,r.width,r.height].every(Number.isFinite)&&r.x>=0&&r.y>=0&&r.width>0&&r.height>0&&r.x+r.width<=1.000001&&r.y+r.height<=1.000001);
  }catch{return[];}
}
export function pdfOutputRatio(width:number,height:number,deviceRatio:number){return Math.min(Math.max(1,deviceRatio||1),2,Math.sqrt(16_000_000/(width*height)),8192/Math.max(width,height));}
