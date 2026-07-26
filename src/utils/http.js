export function sendData(res, data, status = 200) {
  return res.status(status).json({ success: true, data, meta: { requestId: res.req.id } });
}

export function sendList(res, result) {
  return res.json({
    success: true,
    data: result.items,
    pagination: result.pagination || { nextCursor: null, hasMore: false },
    meta: { requestId: res.req.id }
  });
}
