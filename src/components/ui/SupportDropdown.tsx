import React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { HelpCircle, Mail } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";
import { cn } from "../lib/utils";
import logger from "../../utils/logger";

interface SupportDropdownProps {
  className?: string;
  trigger?: React.ReactNode;
}

const SUPPORT_EMAIL = "santiagoespinozac73@gmail.com";
const PRAYER_TEXTS = [
  "Amen!",
  "Amen 🙏",
  "Amen and amen!",
  "Prayer received!",
  "Let it be so!",
  "Hallelujah!",
  "Blessings incoming!",
  "A-MEN!",
];
const PRAYER_COLORS = ["#2563eb", "#7c3aed", "#db2777", "#f59e0b", "#0891b2"];

const randomBetween = (min: number, max: number) => Math.round(min + Math.random() * (max - min));

const createPrayerCelebration = () => ({
  messages: Array.from({ length: 9 }, (_, index) => ({
    id: `amen-${index}-${Math.random()}`,
    text: PRAYER_TEXTS[randomBetween(0, PRAYER_TEXTS.length - 1)],
    left: randomBetween(4, 88),
    delay: randomBetween(0, 500),
    duration: randomBetween(2500, 3200),
    drift: randomBetween(-160, 160),
    rotation: randomBetween(-14, 14),
    color: PRAYER_COLORS[randomBetween(0, PRAYER_COLORS.length - 1)],
  })),
  confetti: Array.from({ length: 56 }, (_, index) => ({
    id: `confetti-${index}-${Math.random()}`,
    left: randomBetween(2, 98),
    delay: randomBetween(0, 350),
    duration: randomBetween(2200, 3000),
    drift: randomBetween(-480, 480),
    rotation: randomBetween(360, 1080),
    color: PRAYER_COLORS[randomBetween(0, PRAYER_COLORS.length - 1)],
  })),
});

const openExternal = async (url: string) => {
  try {
    const result = await window.electronAPI?.openExternal(url);
    if (!result?.success) {
      logger.error("Failed to open URL", { error: result?.error }, "support");
    }
  } catch (error) {
    logger.error("Error opening URL", { error }, "support");
  }
};

export default function SupportDropdown({ className, trigger }: SupportDropdownProps) {
  const { t } = useTranslation();
  const [prayerCelebration, setPrayerCelebration] = React.useState<
    ReturnType<typeof createPrayerCelebration> | null
  >(null);
  const celebrationTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const mailtoUrl = `mailto:${SUPPORT_EMAIL}`;
  const gmailComposeUrl = `https://mail.google.com/mail/?view=cm&to=${SUPPORT_EMAIL}`;

  React.useEffect(() => {
    return () => {
      if (celebrationTimeoutRef.current) clearTimeout(celebrationTimeoutRef.current);
    };
  }, []);

  const triggerPrayerCelebration = () => {
    if (celebrationTimeoutRef.current) clearTimeout(celebrationTimeoutRef.current);
    setPrayerCelebration(createPrayerCelebration());
    celebrationTimeoutRef.current = setTimeout(() => {
      setPrayerCelebration(null);
      celebrationTimeoutRef.current = null;
    }, 3600);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {trigger || (
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "text-foreground/70 hover:text-foreground hover:bg-foreground/10",
                className
              )}
            >
              <HelpCircle size={16} />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={async () => {
              const result = await window.electronAPI?.openExternal(mailtoUrl);
              if (!result?.success) {
                await openExternal(gmailComposeUrl);
              }
            }}
          >
            <Mail className="mr-2 h-4 w-4" />
            {t("support.contactSupport")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={triggerPrayerCelebration}>
            <HelpCircle className="mr-2 h-4 w-4" />
            Help? Pray!
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {prayerCelebration && (
        <div className="prayer-celebration" aria-hidden="true">
          {prayerCelebration.confetti.map((piece) => (
            <span
              key={piece.id}
              className="prayer-confetti"
              style={
                {
                  left: `${piece.left}%`,
                  animationDelay: `${piece.delay}ms`,
                  animationDuration: `${piece.duration}ms`,
                  backgroundColor: piece.color,
                  "--prayer-drift": `${piece.drift}px`,
                  "--prayer-rotation": `${piece.rotation}deg`,
                } as React.CSSProperties
              }
            />
          ))}
          {prayerCelebration.messages.map((message) => (
            <span
              key={message.id}
              className="prayer-amen"
              style={
                {
                  left: `${message.left}%`,
                  animationDelay: `${message.delay}ms`,
                  animationDuration: `${message.duration}ms`,
                  color: message.color,
                  "--prayer-drift": `${message.drift}px`,
                  "--prayer-rotation": `${message.rotation}deg`,
                } as React.CSSProperties
              }
            >
              {message.text}
            </span>
          ))}
        </div>
      )}
    </>
  );
}
