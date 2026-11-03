/**
 * 把一個查詢「分批」讀完。
 *
 * 資料庫一次最多只回 1000 筆，超過的部分不會報錯，而是直接被截掉 —— 畫面和匯出的
 * Excel 會少資料，卻看不出來。所以「全公司、跨月跨年」這種可能超過 1000 筆的查詢，
 * 都要用這個：先讀第 1～1000 筆，再讀第 1001～2000 筆……讀到不滿 1000 筆為止，再合併。
 *
 * makeQuery 每次都要回傳一個「新的」查詢（同一個查詢物件不能重複用），而且最後一個
 * 排序欄位要是唯一的（例如 id）—— 排序不固定的話，分批時可能有一筆被讀兩次或漏掉。
 *
 * 回傳格式跟 supabase 一樣：{ data, error }
 */
export async function fetchAllRows(makeQuery, batchSize = 1000) {
  const rows = []
  for (let from = 0; ; from += batchSize) {
    const { data, error } = await makeQuery().range(from, from + batchSize - 1)
    if (error) return { data: null, error }
    rows.push(...(data || []))
    if (!data || data.length < batchSize) return { data: rows, error: null }
  }
}
