export interface BinanceHeaders {
    'accept': string;
    'accept-language': string;
    'bnc-location': string;
    'bnc-time-zone': string;
    'bnc-uuid': string;
    'cache-control': string;
    'clienttype': string;
    'clientversion': string;
    'content-type': string;
    'csrftoken': string;
    'device-info': string;
    'fvideo-id': string;
    'fvideo-token': string;
    'lang': string;
    'origin': string;
    'pragma': string;
    'priority': string;
    'referer': string;
    'sec-ch-ua': string;
    'sec-ch-ua-mobile': string;
    'sec-ch-ua-platform': string;
    'sec-fetch-dest': string;
    'sec-fetch-mode': string;
    'sec-fetch-site': string;
    'user-agent': string;
    'x-passthrough-token': string;
    'x-trace-id': string;
    'x-ui-request-trace': string;
    'Cookie': string;
  }
  
  export interface ApiResponse<T> {
    code: string;
    message: string | null;
    messageDetail: string | null;
    data: T;
    success: boolean;
  }
  