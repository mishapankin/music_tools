import { useEffect, useState } from "react";

export const useWindowResolution = () => {
  const [resolution, setResolution] = useState({
    x: 0,
    y: 0,
  });

  useEffect(() => {
    const handleResize = () => {
      setResolution({
        x: document.documentElement.clientWidth,
        y: document.documentElement.clientHeight,
      });
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  return resolution;
};
