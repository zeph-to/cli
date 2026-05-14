export interface ZephOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number; // ms, default 30000
}

export interface NotifyPayload {
  title?: string;
  body?: string;
  url?: string;
  type?: 'note' | 'link' | 'file' | 'hook';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  targetDeviceId?: string;
}

export interface NotifyResult {
  pushId: string;
  fileKey?: string;
  autoFile?: boolean;
}

export interface UploadRequestResult {
  fileId: string;
  fileKey: string;
  uploadUrl: string;
}

export interface ListParams {
  limit?: number;
  type?: 'note' | 'link' | 'file' | 'clipboard' | 'hook';
}

export interface PushItem {
  pushId: string;
  type: string;
  title?: string;
  body?: string;
  createdAt: string;
}

export interface ListResult {
  pushes: PushItem[];
  count: number;
  hasMore: boolean;
}

export interface DismissOneResult {
  dismissed: true;
}

export interface DismissAllResult {
  dismissed: number;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    status: number;
  };
}
