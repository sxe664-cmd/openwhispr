import hiraMark from "../../assets/hira-mark.png";

interface BrandLogoProps {
  className?: string;
  alt?: string;
}

/** Shared compact HIRA mark for loading and notification surfaces. */
export function BrandLogo({ className = "", alt = "HIRA" }: BrandLogoProps) {
  return <img src={hiraMark} alt={alt} className={`object-contain ${className}`} draggable={false} />;
}
