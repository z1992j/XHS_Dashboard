import { Maximize2, Image as ImageIcon, Heart, MessageCircle, Star, MoreHorizontal } from 'lucide-react';

// XHS app brand red — fixed value on purpose: this component simulates the
// third-party XHS app UI, so it is exempt from the theme token system.
const XHS_RED = '#ff2442';
const PHONE_TEXT = '#1a1a1a';
const PHONE_TEXT_2 = '#666666';
const PHONE_TEXT_3 = '#999999';

interface PhonePreviewProps {
  title?: string;
  content?: string;
  tags?: string[];
  imageData?: string;
  imageUrl?: string;
  /** 图集总张数，用于显示小红书那样的「1/9」角标 */
  imageCount?: number;
  author?: string;
  compact?: boolean;
}

export default function PhonePreview({
  title = '这里是标题',
  content = '这里是正文内容...',
  tags = [],
  imageData,
  imageUrl,
  imageCount = 0,
  author = '我的账号',
  compact = false,
}: PhonePreviewProps) {
  const resolvedSrc = imageData || imageUrl;
  const previewTitle = title || '这里是标题';
  const previewContent = content || '这里是正文内容...';
  const phoneWidth = compact ? 300 : 340;
  const phoneHeight = compact ? 615 : 700;

  return (
    <div className="flex justify-center">
      <div
        className="phone-frame relative rounded-[44px] p-2"
        style={{ width: phoneWidth, height: phoneHeight }}
      >
        {/* Side buttons */}
        <div className="absolute left-[-2px] top-24 w-[3px] h-8 bg-gray-700 rounded-l-sm" />
        <div className="absolute left-[-2px] top-36 w-[3px] h-12 bg-gray-700 rounded-l-sm" />
        <div className="absolute left-[-2px] top-52 w-[3px] h-12 bg-gray-700 rounded-l-sm" />
        <div className="absolute right-[-2px] top-32 w-[3px] h-16 bg-gray-700 rounded-r-sm" />

        {/* Screen */}
        <div className="phone-screen rounded-[36px] overflow-hidden h-full flex flex-col relative">
          {/* Notch */}
          <div className="absolute top-2 left-1/2 -translate-x-1/2 w-24 h-6 bg-black rounded-full z-20" />

          {/* Status Bar */}
          <div className="flex justify-between items-center px-7 pt-2.5 pb-1 text-[11px] font-semibold relative z-10 phone-statusbar">
            <span>9:41</span>
            <div className="flex items-center gap-1">
              <div className="flex gap-0.5">
                {[3, 4, 5, 6].map(h => <div key={h} className="w-[3px] bg-current rounded-sm" style={{ height: h }} />)}
              </div>
              <span className="text-[9px] ml-0.5">5G</span>
              <div className="w-6 h-3 border border-current rounded-sm relative ml-1">
                <div className="absolute inset-[2px] right-[4px] bg-current rounded-[1px]" />
              </div>
            </div>
          </div>

          {/* Nav Bar — 作者信息在这里，和小红书笔记页一致 */}
          <div className="flex justify-between items-center px-4 py-2 relative z-10 phone-nav gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-lg shrink-0">‹</span>
              <span
                className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[11px] font-semibold text-white"
                style={{ background: XHS_RED }}
                aria-hidden="true"
              >
                {[...(author || '我')][0]}
              </span>
              <span className="text-[12px] font-medium truncate" style={{ color: PHONE_TEXT }}>
                {author}
              </span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <Maximize2 size={15} />
              <MoreHorizontal size={15} />
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            {resolvedSrc ? (
              <div className="relative">
                <img src={resolvedSrc} alt="" className="w-full h-52 object-cover" />
                {imageCount > 1 && (
                  <span
                    className="absolute bottom-2 right-2 text-[10px] px-2 py-0.5 rounded-full"
                    style={{ background: 'rgba(0,0,0,.55)', color: '#fff' }}
                  >
                    1/{imageCount}
                  </span>
                )}
              </div>
            ) : (
              <div className="w-full h-52 phone-image-placeholder flex items-center justify-center">
                <ImageIcon size={32} style={{ color: PHONE_TEXT_3 }} />
              </div>
            )}
            <div className="px-4 py-3">
              <h2 className="font-bold text-[15px] leading-snug mb-2" style={{ color: PHONE_TEXT }}>{previewTitle}</h2>
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap" style={{ color: PHONE_TEXT }}>{previewContent}</p>
              {tags.length > 0 && (
                <div className="mt-2.5 flex flex-wrap gap-x-2 gap-y-1">
                  {tags.map((t, i) => (
                    <span key={i} className="text-[13px]" style={{ color: XHS_RED }}>#{t}</span>
                  ))}
                </div>
              )}
              <p className="text-[11px] mt-2.5" style={{ color: PHONE_TEXT_3 }}>刚刚 · IP属地：未知</p>
            </div>
          </div>

          {/* Interaction Bar */}
          <div className="phone-navbar px-4 py-2.5">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 flex-1 min-w-0 px-3 py-1.5 rounded-full phone-comment-bar">
                <span className="text-[12px] truncate" style={{ color: PHONE_TEXT_3 }}>说点什么...</span>
              </div>
              <div className="flex items-center gap-1">
                <Heart size={19} style={{ color: XHS_RED }} />
                <span className="text-[11px]" style={{ color: PHONE_TEXT_2 }}>1.2w</span>
              </div>
              <div className="flex items-center gap-1">
                <MessageCircle size={19} style={{ color: PHONE_TEXT_2 }} />
                <span className="text-[11px]" style={{ color: PHONE_TEXT_2 }}>328</span>
              </div>
              <div className="flex items-center gap-1">
                <Star size={19} style={{ color: PHONE_TEXT_2 }} />
                <span className="text-[11px]" style={{ color: PHONE_TEXT_2 }}>892</span>
              </div>
            </div>
          </div>

          {/* Home Indicator */}
          <div className="flex justify-center py-1.5">
            <div className="w-28 h-1 rounded-full" style={{ background: PHONE_TEXT }} />
          </div>
        </div>
      </div>
    </div>
  );
}
