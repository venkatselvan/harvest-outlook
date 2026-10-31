import {z} from 'zod';
import {generatePlanningReview,type PlanningDeps} from '../../services/planning-review';
import type {JobHandler} from '../main';
export const createPlanningReviewHandler=(deps:PlanningDeps):JobHandler=>async(job,ctx)=>{
 if(!job.owner_id)return{status:'cancelled',reason:'owner_missing'};
 const{reviewId}=z.object({reviewId:z.uuid()}).parse(job.payload);
 return generatePlanningReview(deps,reviewId,job.owner_id,ctx.isCancelled);
};
