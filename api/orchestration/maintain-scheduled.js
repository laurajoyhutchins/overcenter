export const access = 'scheduler';
export const methods = ['POST'];

export default async function (_req, res) {
  return res.status(410).json({
    ok:false,
    error:'HATCHABLE_MAINTENANCE_SCHEDULE_RETIRED',
    message:'Authoritative orchestration maintenance is scheduled and executed through the GCP control plane.',
    may_have_mutated:false,
  });
}