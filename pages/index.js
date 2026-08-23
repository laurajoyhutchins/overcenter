import { db } from 'hatchable';
import { readPreviewSnapshot, renderPreviewPage } from 'lib/preview-snapshot.js';

export const access = 'public';
export const methods = ['GET'];

export default async function (req, res) {
  const snapshot = await readPreviewSnapshot({ db, req });
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.send(renderPreviewPage(snapshot));
}
