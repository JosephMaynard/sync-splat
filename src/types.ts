interface HtmlItem {
  type: "html";
  data: string;
}

interface ImageItem {
  type: "image";
  mime: string;
  data: string;
}

export type HistoryItemData = HtmlItem | ImageItem;
export type Payload = HistoryItemData; // if you still want the alias
