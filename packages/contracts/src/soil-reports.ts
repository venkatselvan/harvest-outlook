import {z} from 'zod';
import {ModelInvocation} from './boundary-assessment';
const optionalText=z.string().max(300).nullable();
export const SoilParameter=z.enum(['ph','electrical_conductivity','organic_carbon','organic_matter','nitrogen_available','nitrogen_total','nitrogen_unspecified','nitrate_n','ammonium_n','phosphorus_available','phosphorus_total','potassium_available','potassium_total','sulphur_available','zinc_available','boron_available','iron_available','manganese_available','copper_available','calcium_exchangeable','magnesium_exchangeable','sodium_exchangeable','cec','texture','sand','silt','clay','bulk_density','moisture_gravimetric','moisture_volumetric','field_capacity','wilting_point','base_saturation','esp','sar','unknown_other']);
const SoilPageEvidence=z.object({page:z.number().int().min(1).max(8),quote:z.string().max(1500),nativeTextCheck:z.enum(['matched','not_matched','image_review_required'])}).strict();
/** A printed laboratory reference is neither a measured result nor a crop requirement. */
export const SoilReportedReference=z.object({label:z.string().min(1).max(300),rawText:z.string().min(1).max(1000),rawUnit:optionalText,qualifier:z.enum(['exact','less_than','less_or_equal','greater_than','greater_or_equal','range','text']),numericValue:z.number().finite().nullable(),range:z.object({low:z.number().finite(),high:z.number().finite(),lowInclusive:z.boolean().nullable(),highInclusive:z.boolean().nullable()}).strict().nullable(),evidence:SoilPageEvidence}).strict();
export const SoilMarkerDraft=z.object({
 id:z.string().min(1).max(100),parameter:SoilParameter,rawLabel:z.string().min(1).max(300),rawValue:z.string().min(1).max(300),rawUnit:optionalText,numericValue:z.number().finite().nullable(),qualifier:z.enum(['exact','less_than','less_or_equal','greater_than','greater_or_equal','range','below_detection','unreadable','text']),range:z.object({low:z.number().finite(),high:z.number().finite()}).strict().nullable(),
 analyteForm:optionalText,method:optionalText,extractant:optionalText,soilWaterRatio:optionalText,temperatureC:z.number().finite().nullable(),matrix:z.enum(['soil','water','plant','unknown']),massBasis:optionalText,reportedRating:optionalText,
 reportedReference:SoilReportedReference.nullable().optional(),
 evidence:SoilPageEvidence,extractionConfidence:z.enum(['high','medium','low','unreadable']),warnings:z.array(z.string().max(500)).max(20),
}).strict();
export const SoilSampleDraft=z.object({id:z.string().min(1).max(100),sampleLabel:optionalText,laboratory:optionalText,collectionDate:z.iso.date().nullable(),receivedDate:z.iso.date().nullable().optional(),reportDate:z.iso.date().nullable(),depth:z.object({from:z.number().finite().nonnegative(),to:z.number().finite().nonnegative(),unit:z.enum(['cm','m','inch'])}).strict().nullable(),markers:z.array(SoilMarkerDraft).max(100)}).strict();
export const SoilReportExtraction=z.object({title:optionalText,laboratory:optionalText,receivedDate:z.iso.date().nullable().optional(),reportDate:z.iso.date().nullable(),samples:z.array(SoilSampleDraft).max(20),warnings:z.array(z.string().max(1000)).max(30)}).strict();
export const SoilCanonicalValue=z.object({value:z.number().finite().nullable(),unit:optionalText,conversion:z.object({formula:z.string(),version:z.literal('soil-unit-v1')}).strict().nullable(),missingReason:optionalText}).strict();
export const SoilMarker=SoilMarkerDraft.safeExtend({canonical:SoilCanonicalValue,reviewStatus:z.enum(['pending','confirmed']),confirmedAt:z.iso.datetime().nullable()});
export const SoilReport=z.object({
 id:z.uuid(),farmId:z.uuid(),kind:z.enum(['field_report','reference_sample']),status:z.enum(['pending','running','needs_review','confirmed','unavailable','error']),version:z.number().int(),filename:z.string(),contentType:z.string(),bytes:z.number().int(),sha256:z.string(),createdAt:z.iso.datetime(),jobId:z.uuid().nullable(),modelInvocation:ModelInvocation.nullable(),
 originalUrl:z.string(),referenceSource:z.object({title:z.string(),url:z.url(),pages:z.array(z.number().int().positive()),limitations:z.array(z.string()),extractionScope:z.object({sampleLabel:z.string(),description:z.string(),markerLimit:z.number().int().min(1).max(100)}).strict().optional()}).strict().nullable(),
 pages:z.array(z.object({page:z.number().int(),imageUrl:z.string(),width:z.number().int(),height:z.number().int(),nativeTextAvailable:z.boolean()}).strict()),
 extraction:SoilReportExtraction.nullable(),reviewed:SoilReportExtraction.nullable(),confirmedSampleIds:z.array(z.string()),warnings:z.array(z.string()),
}).strict();
export const ReviewSoilReport=z.object({expectedVersion:z.number().int(),draft:SoilReportExtraction}).strict();
export const ConfirmSoilReport=z.object({expectedVersion:z.number().int(),sampleIds:z.array(z.string()).min(1).max(20),markerIds:z.array(z.string()).min(1).max(200)}).strict();
export const FarmSoilMarkers=z.object({farmId:z.uuid(),samples:z.array(z.object({id:z.uuid(),reportId:z.uuid(),sourceSampleId:z.string(),sampleLabel:optionalText,laboratory:optionalText,collectionDate:z.iso.date().nullable(),receivedDate:z.iso.date().nullable().optional(),reportDate:z.iso.date().nullable(),depth:SoilSampleDraft.shape.depth,confirmedAt:z.iso.datetime(),markers:z.array(SoilMarker)}).strict()),limitations:z.array(z.string())}).strict();
export type SoilParameter=z.infer<typeof SoilParameter>;
export type SoilMarkerDraft=z.infer<typeof SoilMarkerDraft>;
export type SoilSampleDraft=z.infer<typeof SoilSampleDraft>;
export type SoilReportExtraction=z.infer<typeof SoilReportExtraction>;
export type SoilReport=z.infer<typeof SoilReport>;
export type SoilCanonicalValue=z.infer<typeof SoilCanonicalValue>;
export type FarmSoilMarkers=z.infer<typeof FarmSoilMarkers>;

export type SoilReportedReference=z.infer<typeof SoilReportedReference>;
