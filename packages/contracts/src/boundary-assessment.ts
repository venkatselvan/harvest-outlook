import {z} from 'zod';
import {GeographicBoundary} from './workspace';
const confidence=z.enum(['low','medium','unknown']);
const evidence=z.object({id:z.string(),title:z.string(),url:z.string().url(),attribution:z.string(),retrievedAt:z.iso.datetime(),limitations:z.array(z.string())}).strict();
export const BoundaryAssessmentInput=z.object({boundary:GeographicBoundary,mediaId:z.uuid().optional()}).strict();
export const BoundarySuggestions=z.object({
 irrigation:z.object({value:z.enum(['rainfed','supplemental','irrigated','unknown']),confidence,reason:z.string().max(1000),uncertainties:z.array(z.string().max(500)).max(8),sources:z.array(z.string()).max(8)}).strict(),
 landCondition:z.object({summary:z.string().max(1500),confidence,uncertainties:z.array(z.string().max(500)).max(8),sources:z.array(z.string()).max(8)}).strict(),
}).strict();
export const ModelInvocation=z.object({id:z.uuid(),provider:z.literal('meta'),requestedModel:z.string(),model:z.string().nullable(),purpose:z.string(),status:z.enum(['running','succeeded','failed']),startedAt:z.iso.datetime(),finishedAt:z.iso.datetime().nullable(),processing:z.literal('standard'),requestedStorage:z.literal(false),responseDeleted:z.boolean().nullable()}).strict();
export const BoundaryAssessment=z.object({
 id:z.uuid(),status:z.enum(['assessed','partial','unavailable']),suggestedName:z.string(),areaHectares:z.number().positive(),centroid:z.object({lat:z.number(),lon:z.number()}).strict(),
 location:z.object({status:z.enum(['resolved','partial','unavailable']),countryCode:z.string().nullable(),stateId:z.string().nullable(),stateName:z.string().nullable(),districtId:z.string().nullable(),districtName:z.string().nullable(),source:z.string().nullable(),uncertainties:z.array(z.string())}).strict(),
 weather:z.object({status:z.enum(['fresh','stale','unavailable']),source:z.string(),attribution:z.string(),issuedAt:z.iso.datetime().nullable(),days:z.array(z.object({date:z.iso.date(),rainMm:z.number().nullable(),tMinC:z.number().nullable(),tMaxC:z.number().nullable()}).strict())}).strict(),
 imagery:z.object({status:z.enum(['available','unavailable']),source:z.string().nullable(),attribution:z.string().nullable(),capturedAt:z.iso.datetime().nullable(),imageryDate:z.string().nullable(),kind:z.enum(['map_snapshot','farmer_photo','none']),previewUrl:z.string().optional(),limitations:z.array(z.string())}).strict(),
 suggestions:BoundarySuggestions,requiresConfirmation:z.literal(true),confidenceBasis:z.literal('uncalibrated_model_assessment'),sources:z.array(evidence),modelInvocation:ModelInvocation.nullable(),limitations:z.array(z.string()),
}).strict();
export type BoundaryAssessmentInput=z.infer<typeof BoundaryAssessmentInput>;
export type BoundaryAssessment=z.infer<typeof BoundaryAssessment>;
export type BoundarySuggestions=z.infer<typeof BoundarySuggestions>;
export type ModelInvocation=z.infer<typeof ModelInvocation>;
