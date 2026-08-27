import { executeCorrelatedCommand } from 'lib/orchestration-journal.js';
import { orchestrationTargetResumePacket } from 'lib/orchestration-run-target-runtime.js';
export const access='admin'; export const methods=['POST'];
export default async function(req,res){ const response=await executeCorrelatedCommand('orchestration.resume_packet',req.body||{},input=>orchestrationTargetResumePacket(input),{flattenDetails:true}); return res.status(response.status).json(response.body); }