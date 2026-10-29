export interface Farm {
  id: string;
  name: string;
  location: { districtId: string | null; districtName: string | null; stateCode: string | null; precision: string };
  areaHectares: number | null;
  warnings?: { code: string; message: string }[];
  facts: Record<string, { value: unknown; unit: string | null; basis: string; confirmed: boolean }>;
}
