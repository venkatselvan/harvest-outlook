import {promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import sharp from 'sharp';
import {processImage,sniffImage} from './media';
import {ApiError} from './errors';
const run=promisify(execFile);
const bundled=join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/override/pdftoppm');
const renderer=()=>process.env.SOIL_PDFTOPPM_PATH??(existsSync(bundled)?bundled:'pdftoppm');
export interface ReportPage{page:number;data:Buffer;width:number;height:number;nativeText:string|null}
export async function renderSoilPages(data:Buffer):Promise<{contentType:string;pages:ReportPage[]}>{
 if(sniffImage(data)){const image=await processImage(data);const page=await sharp(data,{limitInputPixels:64000000}).rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).jpeg({quality:94}).toBuffer({resolveWithObject:true});return{contentType:image.kind.mime,pages:[{page:1,data:page.data,width:page.info.width,height:page.info.height,nativeText:null}]}}
 if(data.subarray(0,5).toString()!=='%PDF-')throw new ApiError(415,'unsupported_report_type','Upload a PDF, JPEG, PNG or WebP report');
 const dir=await mkdtemp(join(tmpdir(),'harvest-soil-'));const input=join(dir,'report.pdf');
 try{
  await writeFile(input,data);const fontFile=join(dir,'fonts.conf');await mkdir(join(dir,'font-cache'));const escaped=dir.replace(/&/g,'&amp;').replace(/</g,'&lt;');await writeFile(fontFile,`<fontconfig><dir>/System/Library/Fonts</dir><dir>/Library/Fonts</dir><dir>/usr/share/fonts</dir><cachedir>${escaped}/font-cache</cachedir></fontconfig>`);const renderEnv={...process.env,FONTCONFIG_FILE:fontFile,FONTCONFIG_PATH:dir,XDG_CACHE_HOME:dir};let info:string;
  try{info=(await run('pdfinfo',[input],{timeout:10000,maxBuffer:512000})).stdout}catch{throw new ApiError(422,'invalid_pdf','PDF is invalid, encrypted or cannot be read')}
  const count=Number(/^Pages:\s+(\d+)/m.exec(info)?.[1]);if(!count||count>8)throw new ApiError(413,'report_page_limit','Upload a report or excerpt with at most eight pages');
  const pages:ReportPage[]=[];
  for(let page=1;page<=count;page++){
   const prefix=join(dir,`page-${page}`);
   try{await run(renderer(),['-f',String(page),'-l',String(page),'-scale-to','2400','-png','-singlefile',input,prefix],{timeout:20000,maxBuffer:512000,env:renderEnv})}catch{throw new ApiError(422,'pdf_render_failed','A PDF page could not be rendered safely')}
   const rendered=await sharp(await readFile(prefix+'.png'),{limitInputPixels:8000000}).jpeg({quality:94}).toBuffer({resolveWithObject:true});
   let nativeText:string|null=null;try{nativeText=(await run('pdftotext',['-f',String(page),'-l',String(page),'-layout',input,'-'],{timeout:10000,maxBuffer:1000000})).stdout.slice(0,50000).trim()||null}catch{/* image-only page; review against its pixels */}
   pages.push({page,data:rendered.data,width:rendered.info.width,height:rendered.info.height,nativeText});
  }
  return{contentType:'application/pdf',pages};
 }finally{await rm(dir,{recursive:true,force:true})}
}
