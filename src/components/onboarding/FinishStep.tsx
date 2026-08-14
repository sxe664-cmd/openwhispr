import { useTranslation } from "react-i18next";
import { Check, Settings } from "lucide-react";
import { Button } from "../ui/button";

interface FinishStepProps {
  onFinish: (openSettings: boolean) => void;
  isFinishing: boolean;
}

export default function FinishStep({ onFinish, isFinishing }: FinishStepProps) {
  const { t } = useTranslation();

  return (
    <div className="space-y-4">
      <div className="text-center space-y-0.5">
        <div className="w-12 h-12 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-3">
          <Check className="w-6 h-6 text-green-500" />
        </div>
        <h2 className="text-lg font-semibold text-foreground tracking-tight">
          {t("onboarding.finish.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("onboarding.finish.localDescription")}</p>
      </div>

      <p className="text-xs text-muted-foreground text-center">
        {t("onboarding.finish.cleanupNote")}
      </p>

      <div className="flex items-center justify-center gap-2">
        <Button
          variant="outline"
          onClick={() => onFinish(true)}
          disabled={isFinishing}
          className="h-8 px-5 rounded-full text-xs"
        >
          <Settings className="w-3.5 h-3.5" />
          {t("onboarding.finish.openSettings")}
        </Button>
        <Button
          variant="success"
          onClick={() => onFinish(false)}
          disabled={isFinishing}
          className="h-8 px-6 rounded-full text-xs"
        >
          <Check className="w-3.5 h-3.5" />
          {t("onboarding.finish.skipForNow")}
        </Button>
      </div>
    </div>
  );
}
