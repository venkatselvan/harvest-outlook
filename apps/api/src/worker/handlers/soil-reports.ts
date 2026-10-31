import {z} from 'zod';
import type {JobHandler} from '../main';
import {extractSoilReport,type SoilDeps} from '../../services/soil-reports';
export const createSoilHandler=(deps:SoilDeps):JobHandler=>async(job,ctx)=>{if(!job.owner_id)return{status:'cancelled'};const{reportId}=z.object({reportId:z.uuid()}).parse(job.payload);return extractSoilReport(deps,job.owner_id,reportId,ctx.isCancelled)};
